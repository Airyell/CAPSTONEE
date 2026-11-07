<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

/**
 * RBAC — step 2: "Is this role allowed here?"
 *
 * Must run AFTER 'auth.staff'. Returns 403 if the logged-in staff's
 * user_role is not one of the roles listed on the route.
 *
 * Usage in routes:  ->middleware('role:Admin')
 *                   ->middleware('role:Registrar Staff')
 *                   ->middleware('role:Admin,Registrar Staff')
 *
 * Alias (see Kernel.php): 'role'
 */
class EnsureRole
{
    public function handle(Request $request, Closure $next, ...$roles)
    {
        $staff = $request->attributes->get('staff');

        if (!$staff) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        $allowed  = array_map(fn ($r) => strtolower(trim($r)), $roles);
        $userRole = strtolower(trim((string) $staff->user_role));

        if (!in_array($userRole, $allowed, true)) {
            return response()->json([
                'message' => 'Forbidden. Your role does not have access to this resource.',
            ], 403);
        }

        return $next($request);
    }
}