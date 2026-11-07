<?php

use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| RegisScan Web Routes
|--------------------------------------------------------------------------
|
| These routes serve the React application.
|
*/

/*
|--------------------------------------------------------------------------
| Main Application
|--------------------------------------------------------------------------
*/

Route::get('/', function () {
    return view('welcome');
});

/*
|--------------------------------------------------------------------------
| Student Records
|--------------------------------------------------------------------------
*/

Route::get('/students', function () {
    return view('welcome');
});

/*
|--------------------------------------------------------------------------
| Specific Student Profile
|--------------------------------------------------------------------------
|
| Example:
|
| /students/2024001234
|
*/

Route::get('/students/{student_id}', function ($student_id) {
    return view('welcome');
})->where('student_id', '[^/]+');

/*
|--------------------------------------------------------------------------
| Departments
|--------------------------------------------------------------------------
*/

Route::get('/departments', function () {
    return view('welcome');
});

/*
|--------------------------------------------------------------------------
| Requests
|--------------------------------------------------------------------------
*/

Route::get('/requests', function () {
    return view('welcome');
});

Route::get('/admin/staff-accounts', function () { return view('welcome'); });
Route::get('/admin/system-reports', function () { return view('welcome'); });
Route::get('/admin/audit-logs', function () { return view('welcome'); });

Route::get('/departments/{dept_code}', function ($dept_code) {
    return view('welcome');
})->where('dept_code', '[^/]+');

Route::get('/', function () {
    return response()->json([
        'application' => 'RegisScan Backend',
        'status' => 'running',
    ]);
});