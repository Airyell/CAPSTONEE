<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;


class Document extends Model
{

    protected $table="tbl_documents";


    protected $primaryKey="document_id";


    public $timestamps=false;


    protected $fillable=[
        'document_name'
    ];

}