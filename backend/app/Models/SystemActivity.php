<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class SystemActivity extends Model
{
    protected $table      = 'tbl_system_activity';
    protected $primaryKey = 'activity_id';
    public    $timestamps = false;

    protected $fillable = [
        'staff_id',
        'activity_type',
        'activity_description',
        'module_name',
        'date_time',
        'status',
    ];

    protected $casts = [
        'date_time' => 'datetime',
    ];

    public function staff()
    {
        return $this->belongsTo(Staff::class, 'staff_id', 'staff_id');
    }
}