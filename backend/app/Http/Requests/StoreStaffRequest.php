<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreStaffRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
    return [
        'idNumber' => ['required', 'string', 'max:50', 'unique:tbl_staff,username'],
        'fullName' => ['required', 'string', 'max:50'],
        'email'    => ['required', 'email', 'max:100', 'unique:tbl_staff,email'],
        'password' => ['required', 'string', 'min:6', 'max:24'],
        ];
    }
}