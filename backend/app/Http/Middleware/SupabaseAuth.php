<?php
namespace App\Http\Middleware;

use App\Models\Staff;
use Closure;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;

class SupabaseAuth
{
    public function handle($request, Closure $next)
    {
        $token = $request->bearerToken();
        if (!$token) return response()->json(['message' => 'Unauthorized'], 401);

        try {
            $payload = JWT::decode($token, new Key(env('SUPABASE_JWT_SECRET'), 'HS256'));
        } catch (\Throwable $e) {
            return response()->json(['message' => 'Invalid token'], 401);
        }

        $staff = Staff::where('auth_user_id', $payload->sub)->first();
        if (!$staff) return response()->json(['message' => 'No staff account'], 403);

        $request->attributes->set('staff', $staff);
        return $next($request);
    }
}