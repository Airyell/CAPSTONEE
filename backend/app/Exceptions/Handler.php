<?php

namespace App\Exceptions;

use Illuminate\Auth\Access\AuthorizationException; // ADDED
use Illuminate\Auth\AuthenticationException; // ADDED
use Illuminate\Database\Eloquent\ModelNotFoundException; // ADDED
use Illuminate\Foundation\Exceptions\Handler as ExceptionHandler;
use Illuminate\Validation\ValidationException; // ADDED
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface; // ADDED
use Throwable;

class Handler extends ExceptionHandler
{
    /**
     * A list of exception types with their corresponding custom log levels.
     *
     * @var array<class-string<\Throwable>, \Psr\Log\LogLevel::*>
     */
    protected $levels = [
        //
    ];

    /**
     * A list of the exception types that are not reported.
     *
     * @var array<int, class-string<\Throwable>>
     */
    protected $dontReport = [
        //
    ];

    /**
     * A list of the inputs that are never flashed to the session on validation exceptions.
     *
     * @var array<int, string>
     */
    protected $dontFlash = [
        'current_password',
        'password',
        'password_confirmation',
    ];

    /**
     * Register the exception handling callbacks for the application.
     *
     * @return void
     */
    public function register()
    {
        $this->reportable(function (Throwable $e) {
            //
        });

        // ADDED: never send SQL or server details to the browser (details still go to storage/logs/laravel.log)
        $this->renderable(function (Throwable $e, $request) {
            if (!$request->is('api/*') && !$request->expectsJson()) {
                return null;
            }

            // keep Laravel's normal responses for these (validation messages, 401, 403, 404)
            if ($e instanceof ValidationException
                || $e instanceof AuthenticationException
                || $e instanceof AuthorizationException
                || $e instanceof ModelNotFoundException
                || $e instanceof HttpExceptionInterface) {
                return null;
            }

            return response()->json([
                'message' => 'We could not complete your request. Please try again.',
            ], 500);
        });
    }
}