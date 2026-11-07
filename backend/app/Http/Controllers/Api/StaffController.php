<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreStaffRequest;
use App\Http\Requests\UpdateStaffRequest;
use App\Http\Resources\StaffResource;
use App\Models\Staff;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Hash; // ADDED (hash)
use Illuminate\Support\Facades\Http;

class StaffController extends Controller
{
    /**
     * GET /api/staff
     * Only returns Registrar Staff — Admin is excluded from this list.
     */
    public function index(Request $request)
    {
        $search = $request->query('search');

        $query = Staff::query()
            ->select('tbl_staff.*')
            // Exclude Admin — admin manages staff but doesn't appear in the staff list
            ->where('user_role', '!=', 'Admin')
            ->selectSub(function ($q) {
                $q->from('tbl_system_activity')
                  ->selectRaw('MAX(date_time)')
                  ->whereColumn('tbl_system_activity.staff_id', 'tbl_staff.staff_id')
                  ->where('activity_type', 'login');
            }, 'last_login')
            ->orderBy('staff_id');

        if (filled($search)) {
            $query->where(function ($q) use ($search) {
                $q->where('username', 'ilike', "%{$search}%")
                  ->orWhere('name', 'ilike', "%{$search}%")
                  ->orWhere('email', 'ilike', "%{$search}%");
                if (preg_match('/^STF-?0*(\d+)$/i', trim($search), $m)) {
                    $q->orWhere('staff_id', (int) $m[1]);
                }
            });
        }

        $staff = $query->get();

        // Count only non-admin staff
        $baseQuery = Staff::where('user_role', '!=', 'Admin');

        return StaffResource::collection($staff)->additional([
            'meta' => [
                'total'    => (clone $baseQuery)->count(),
                'active'   => (clone $baseQuery)->where('status', 'Active')->count(),
                'inactive' => (clone $baseQuery)->where('status', 'Inactive')->count(),
            ],
        ]);
    }

    /**
     * POST /api/staff
     * New staff always starts as Inactive — becomes Active on first login.
     */
    public function store(StoreStaffRequest $request)
    {
        // CHANGED (id): username is the ID number typed in the form (the login ID)
        $username = trim($request->validated('idNumber'));

        // ADDED (id): the ID number must not belong to another staff member
        if (Staff::where('username', $username)->exists()) {
            return response()->json([
                'message' => 'That ID number is already in use.',
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        // create the Supabase login first, so the new staff can sign in
        $res = $this->supabaseRequest('post', '/auth/v1/admin/users', [
            'email'         => $request->validated('email'),
            'password'      => $request->validated('password'),
            'email_confirm' => true,
            'user_metadata' => ['display_name' => $request->validated('fullName')],
        ]);

        if (!$res->successful()) {
            return response()->json([
                'message' => $this->supabaseError($res),
            ], Response::HTTP_UNPROCESSABLE_ENTITY);
        }

        $authUserId = $res->json('id');

        try {
            $staff = Staff::create([
                'username'     => $username,                        // CHANGED (id): the ID number
                'name'         => $request->validated('fullName'),  // full name
                'email'        => $request->validated('email'),
                'password'     => Hash::make($request->validated('password')), // CHANGED (hash): was the plain password
                'user_role'    => 'Registrar Staff',
                'status'       => 'Inactive', // system will set to Active on login
                'auth_user_id' => $authUserId,
            ]);
        } catch (\Throwable $e) {
            // don't leave an orphan login behind if the staff row failed
            $this->supabaseRequest('delete', "/auth/v1/admin/users/{$authUserId}");
            throw $e;
        }

        $staff = Staff::find($staff->staff_id);

        return (new StaffResource($staff))
            ->response()
            ->setStatusCode(Response::HTTP_CREATED);
    }

    /**
     * PUT /api/staff/{staff}
     * Admin can edit name, email, password — but NOT status (system controls that).
     */
    public function update(UpdateStaffRequest $request, Staff $staff)
    {
        $data = [
            'name'  => $request->validated('fullName'),
            'email' => $request->validated('email'),
        ];

        // ADDED (id): the ID number (username column) can be edited too
        $newUsername = trim((string) $request->validated('idNumber'));

        if ($newUsername !== '' && $newUsername !== $staff->username) {
            if (Staff::where('username', $newUsername)->where('staff_id', '!=', $staff->staff_id)->exists()) {
                return response()->json([
                    'message' => 'That ID number is already in use.',
                ], Response::HTTP_UNPROCESSABLE_ENTITY);
            }

            $data['username'] = $newUsername;
        }

        if (filled($request->validated('password'))) {
            $data['password'] = Hash::make($request->validated('password')); // CHANGED (hash): was the plain password
        }

        // keep the Supabase login in sync with the edit
        $emailChanged    = $request->validated('email') !== $staff->email;
        $passwordChanged = filled($request->validated('password'));
        $nameChanged     = $request->validated('fullName') !== $staff->name;

        if ($staff->auth_user_id) {
            if ($emailChanged || $passwordChanged || $nameChanged) {
                $payload = ['email_confirm' => true];
                if ($emailChanged)    $payload['email']    = $request->validated('email');
                if ($passwordChanged) $payload['password'] = $request->validated('password');
                if ($nameChanged)     $payload['user_metadata'] = ['display_name' => $request->validated('fullName')];

                $res = $this->supabaseRequest('put', "/auth/v1/admin/users/{$staff->auth_user_id}", $payload);

                if (!$res->successful()) {
                    return response()->json([
                        'message' => $this->supabaseError($res),
                    ], Response::HTTP_UNPROCESSABLE_ENTITY);
                }
            }
        } elseif ($passwordChanged) {
            // Older staff row without a Supabase login yet: create it now
            $res = $this->supabaseRequest('post', '/auth/v1/admin/users', [
                'email'         => $request->validated('email'),
                'password'      => $request->validated('password'),
                'email_confirm' => true,
                'user_metadata' => ['display_name' => $request->validated('fullName')],
            ]);

            if (!$res->successful()) {
                return response()->json([
                    'message' => $this->supabaseError($res),
                ], Response::HTTP_UNPROCESSABLE_ENTITY);
            }

            $data['auth_user_id'] = $res->json('id');
        }

        $staff->update($data);

        return new StaffResource($staff);
    }

    /**
     * DELETE /api/staff/{staff}
     */
    public function destroy(Staff $staff)
    {
        // remove the Supabase login too (404 = already gone, which is fine)
        if ($staff->auth_user_id) {
            $res = $this->supabaseRequest('delete', "/auth/v1/admin/users/{$staff->auth_user_id}");

            if (!$res->successful() && $res->status() !== 404) {
                return response()->json([
                    'message' => $this->supabaseError($res),
                ], Response::HTTP_UNPROCESSABLE_ENTITY);
            }
        }

        // remove this staff member's activity rows first (they point to the staff row)
        \DB::table('tbl_system_activity')->where('staff_id', $staff->staff_id)->delete();

        $staff->delete();
        return response()->noContent();
    }

    /**
     * POST /api/staff/{staff}/login
     * Call this when a staff member successfully logs in — sets status to Active.
     */
    public function setActive(Staff $staff)
    {
        $staff->update(['status' => 'Active']);
        return response()->json(['message' => 'Staff set to Active.']);
    }

    /**
     * POST /api/staff/{staff}/logout
     * Call this when a staff member logs out — sets status to Inactive.
     */
    public function setInactive(Staff $staff)
    {
        $staff->update(['status' => 'Inactive']);
        return response()->json(['message' => 'Staff set to Inactive.']);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /** Calls the Supabase Auth admin API with the secret key (server-side only). */
    private function supabaseRequest(string $method, string $path, array $payload = [])
    {
        return Http::withHeaders([
            'apikey' => env('SUPABASE_SERVICE_KEY'),
        ])->{$method}(env('SUPABASE_URL') . $path, $payload);
    }

    /** Turns a Supabase error response into a readable message for the form. */
    private function supabaseError($res): string
    {
        $msg = $res->json('msg') ?? $res->json('message') ?? $res->json('error_description') ?? '';

        if (stripos($msg, 'already') !== false) {
            return 'That email is already registered.';
        }
        if (stripos($msg, 'password') !== false) {
            return 'Password must be at least 6 characters.';
        }

        return $msg !== '' ? $msg : 'Could not update the login account. Please try again.';
    }
}