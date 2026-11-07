<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

class HashStaffPasswords extends Command
{
    protected $signature = 'staff:hash-passwords';
    protected $description = 'Hash plain-text passwords in tbl_staff (bcrypt)';

    public function handle()
    {
        $count = 0;

        foreach (DB::table('tbl_staff')->whereNotNull('password')->get(['staff_id', 'password']) as $row) {
            // skip empty values and passwords that are already hashed
            if ($row->password === '' || Hash::info($row->password)['algoName'] !== 'unknown') {
                continue;
            }

            DB::table('tbl_staff')
                ->where('staff_id', $row->staff_id)
                ->update(['password' => Hash::make($row->password)]);

            $count++;
        }

        $this->info("Hashed {$count} password(s).");
    }
}