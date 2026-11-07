<?php

namespace App\Console\Commands;

use App\Models\Staff;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;

class MigrateStaffToSupabase extends Command
{
    protected $signature = 'migrate:staff-to-supabase';
    protected $description = 'Copy existing staff into Supabase Auth';

    public function handle()
    {
        foreach (Staff::whereNull('auth_user_id')->get() as $staff) {
            $res = Http::withHeaders([
                'apikey' => env('SUPABASE_SERVICE_KEY'),
            ])->post(env('SUPABASE_URL') . '/auth/v1/admin/users', [
                'email' => $staff->email,
                'password' => $staff->password,
                'email_confirm' => true,
                    'user_metadata' => [
                         'display_name' => $staff->username,
                    ],

            ]);

            if ($res->successful()) {
                $staff->update(['auth_user_id' => $res->json('id')]);
                $this->info("OK: {$staff->email}");
            } else {
                $this->error("Failed: {$staff->email} " . $res->body());
            }
        }
    }
}