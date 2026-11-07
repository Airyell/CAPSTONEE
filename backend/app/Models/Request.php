<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;


class Request extends Model
{

    protected $table="tbl_request";

    protected $primaryKey="request_id";

    public $timestamps=false;


    protected $fillable=[

        'document_id',
        'student_id',
        'date_request'

    ];



    public function requestDocuments()
    {

        return $this->hasMany(
            RequestDocument::class,
            'request_id'
        );

    }


}