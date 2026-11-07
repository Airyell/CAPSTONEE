<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Staff;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * RBAC — issues / revokes the API token used by the React app.
 *
 * POST /api/auth/login   { username, password } → { token, staff:{id,username,role} }
 * POST /api/auth/logout  (Bearer token)         → 204
 * GET  /api/auth/me      (Bearer token)         → { id, username, role }
 */
class AuthController extends Controller
{
    private const TOKEN_TTL_HOURS = 8;

    public function login(Request $request)
    {
        $creds = $request->validate([
            'username' => ['required', 'string'],
            'password' => ['required', 'string'],
        ]);

        $staff = Staff::where('username', $creds['username'])->first();

        if (!$staff || !$this->passwordMatches($creds['password'], (string) $staff->password)) {
            return response()->json(['message' => 'Invalid username or password.'], 401);
        }

        // Random token → give the plain value to the client, store only its hash.
        $plainToken = Str::random(64);
        $expiresAt  = now()->addHours(self::TOKEN_TTL_HOURS);

        Staff::where('staff_id', $staff->staff_id)->update([
            'api_token'            => hash('sha256', $plainToken),
            'api_token_expires_at' => $expiresAt,
        ]);

        return response()->json([
            'token'      => $plainToken,
            'token_type' => 'Bearer',
            'expires_at' => $expiresAt->toIso8601String(),
            'staff'      => [
                'id'       => $staff->staff_id,
                'username' => $staff->username,
                'role'     => $staff->user_role,
            ],
        ]);
    }

    public function logout(Request $request)
    {
        $staff = $request->attributes->get('staff');

        Staff::where('staff_id', $staff->staff_id)->update([
            'api_token'            => null,
            'api_token_expires_at' => null,
        ]);

        return response()->noContent();
    }

    public function me(Request $request)
    {
        $staff = $request->attributes->get('staff');

        return response()->json([
            'id'       => $staff->staff_id,
            'username' => $staff->username,
            'role'     => $staff->user_role,
        ]);
    }

    /**
     * Your current accounts store plain-text passwords, so a plain comparison
     * is used. If you later switch to bcrypt hashes this still works.
     */
    private function passwordMatches(string $input, string $stored): bool
    {
        if (Hash::info($stored)['algoName'] !== 'unknown') {
            return Hash::check($input, $stored);
        }

        return hash_equals($stored, $input);
    }
}