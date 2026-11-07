<?php

namespace App\Http\Middleware;

use App\Models\Staff;
use Carbon\Carbon;
use Closure;
use Firebase\JWT\JWK;
use Firebase\JWT\JWT;
use Illuminate\Contracts\Auth\Middleware\AuthenticatesRequests;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

/**
 * RBAC — step 1: "Who is calling?"
 *
 * Reads the "Authorization: Bearer <token>" header, finds the matching staff
 * account and stores it on the request. Rejects with 401 if the token is
 * missing, unknown or expired.
 *
 * Alias (see Kernel.php): 'auth.staff'
 */
class AuthenticateStaff implements AuthenticatesRequests
{
    public function handle(Request $request, Closure $next)
    {
        $token = $request->bearerToken();

        if (!$token) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        // Supabase Auth token (checked first). If it isn't a valid Supabase
        // token, fall through to the existing api_token check below.
        try {
            $jwks = Cache::remember('supabase_jwks', 3600, function () {
                return Http::get(env('SUPABASE_URL') . '/auth/v1/.well-known/jwks.json')->json();
            });

            $payload = JWT::decode($token, JWK::parseKeySet($jwks, 'ES256'));
            $supabaseStaff = Staff::where('auth_user_id', $payload->sub)->first();

            if ($supabaseStaff) {
                $request->attributes->set('staff', $supabaseStaff);
                $request->setUserResolver(fn () => $supabaseStaff);

                return $next($request);
            }
        } catch (\Throwable $e) {
            \Log::warning('Supabase JWT failed: ' . $e->getMessage());
        }

        // Only the SHA-256 hash of the token is stored in the database.
        $staff = Staff::where('api_token', hash('sha256', $token))->first();

        if (!$staff) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        if ($staff->api_token_expires_at && Carbon::parse($staff->api_token_expires_at)->isPast()) {
            return response()->json(['message' => 'Session expired. Please log in again.'], 401);
        }

        $request->attributes->set('staff', $staff);
        $request->setUserResolver(fn () => $staff);

        return $next($request);
    }
}