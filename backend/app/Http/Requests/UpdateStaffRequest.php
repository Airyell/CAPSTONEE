<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateStaffRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {   
    $staffId = $this->route('staff')->staff_id;

    return [
        'idNumber' => ['required', 'string', 'max:50'],
        'fullName' => ['required', 'string', 'max:50'],
        'email'    => ['required', 'email', 'max:100', Rule::unique('tbl_staff', 'email')->ignore($staffId, 'staff_id')],
        'password' => ['nullable', 'string', 'min:6', 'max:24'],
        ];
    }
}