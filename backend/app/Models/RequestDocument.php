<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;


class RequestDocument extends Model
{

    protected $table = 'tbl_request_document';


    protected $primaryKey = 'request_document_id';


    public $timestamps = false;



    protected $fillable = [

        'request_id',
        'document_id',
        'status',
        'rejection_reason'
    ];



    public function request()
    {
        return $this->belongsTo(Request::class,'request_id');
    }



    public function document()
    {
        return $this->belongsTo(Document::class,'document_id');
    }

}