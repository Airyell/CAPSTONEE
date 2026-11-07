<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\OcrController;
use App\Http\Controllers\Api\StaffController;
use App\Http\Controllers\Api\ReportsController;
use App\Http\Controllers\Api\DepartmentController;
use App\Http\Controllers\Api\AuthController; // RBAC
use App\Http\Controllers\RequestController;
use App\Http\Controllers\StudentController;

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
|
| Here is where you can register API routes for your application. These
| routes are loaded by the RouteServiceProvider within a group which
| is assigned the "api" middleware group. Enjoy building your API!
|
*/

// ── RBAC: login issues a token (public, rate-limited) ──
Route::post('/auth/login', [AuthController::class, 'login'])->middleware('throttle:10,1');

// ── RBAC: OCR is for Registrar Staff only ──
Route::post('/ocr/extract', [OcrController::class, 'extract'])
    ->middleware(['auth.staff', 'role:Registrar Staff']);

Route::middleware('auth:sanctum')->get('/user', function (Request $request) {
    return $request->user();
});

// STUDENT REQUEST
Route::get('/request/student/{student_id}', [RequestController::class, 'getByStudent']);
Route::post('/request', [RequestController::class, 'store']);

Route::get('/student/{id}', function ($id) {
    $student = DB::table('tbl_student as s')
        ->leftJoin('tbl_program as p', 's.program_id', '=', 'p.program_id')
        ->where('s.student_id', $id)
        ->select('s.first_name', 's.last_name', 's.middle_name', 's.email', 's.year_level', 'p.program_name')
        ->first();

    if (!$student) return response()->json(['message' => 'Student not found'], 404);

    return response()->json($student);
});

// ── RBAC: any logged-in staff (token required) ──
Route::middleware('auth.staff')->group(function () {
    Route::get('/auth/me',      [AuthController::class, 'me']);
    Route::post('/auth/logout', [AuthController::class, 'logout']);
});

// ── RBAC: REGISTRAR STAFF ONLY — departments/colleges ──
Route::middleware(['auth.staff', 'role:Registrar Staff'])->group(function () {
    Route::get('/colleges', [DepartmentController::class, 'index']);
    Route::get('/colleges/{collegeId}/students', [DepartmentController::class, 'students']);
});

// ── RBAC: ADMIN ONLY — reports and staff management ──
Route::middleware(['auth.staff', 'role:Admin'])->group(function () {

    Route::get('reports', [ReportsController::class, 'index']);
    Route::get('reports/archived-logs', [ReportsController::class, 'archivedLogs']); // ADDED

    Route::apiResource('staff', StaffController::class)->only([
        'index', 'store', 'update', 'destroy',
    ]);
});
Route::middleware('auth.staff')->group(function () {
    Route::post('/auth/session', [AuthController::class, 'session']);
    Route::post('/auth/logout', [AuthController::class, 'logout']);
    // ...all your existing staff, reports, documents routes
});

// These fire during any staff member's own login/logout (Admin or Registrar),
// before an RBAC token even exists yet — so they stay public, same as before RBAC.
Route::post('staff/{staff}/login',  [StaffController::class, 'setActive']);
Route::post('staff/{staff}/logout', [StaffController::class, 'setInactive']);

Route::post('/students', [StudentController::class, 'store']);