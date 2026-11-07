<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class RequestController extends Controller
{
    // GET /api/request/student/{student_id}
    public function getByStudent($student_id)
    {
        $requests = DB::select("
            SELECT 
                r.request_id,
                r.student_id,
                r.date_request,
                r.purpose,
                d.document_name,
                rd.status
            FROM tbl_request r
            JOIN tbl_request_document rd ON r.request_id = rd.request_id
            JOIN tbl_documents d ON rd.document_id = d.document_id
            WHERE r.student_id = ?
        ", [$student_id]);

        return response()->json($requests);
    }

    // POST /api/request
    public function store(Request $request)
    {
        $validated = $request->validate([
            'student_id'  => 'required|integer',
            'document_id' => 'required|integer',
            'documents'   => 'required|array',
            'documents.*' => 'integer',
            'purpose'     => 'nullable|string',

            // Pre-form ("Before You Proceed" step)
            'contact_number'        => 'nullable|string|max:20',
            'is_graduate'           => 'nullable|boolean',
            'graduate_year'         => 'nullable|string|max:10',
            'last_semester'         => 'nullable|string|max:20',
            'last_sy_start'         => 'nullable|string|max:10',
            'last_sy_end'           => 'nullable|string|max:10',
            'requested_before'      => 'nullable|boolean',
            'previous_credential'   => 'nullable|string|max:100',
            'previous_request_date' => 'nullable|date',
            'is_cleared'            => 'nullable|boolean',

            // Request-type sub-fields
            'agency'                => 'nullable|string|max:100',
            'agency_other'          => 'nullable|string|max:150',
            'certification_type'    => 'nullable|string|max:100',
            'certification_other'   => 'nullable|string|max:150',
            'subject_semester'      => 'nullable|string|max:20',
            'subject_sy_start'      => 'nullable|string|max:10',
            'subject_sy_end'        => 'nullable|string|max:10',
        ]);

        $requestId = DB::table('tbl_request')->insertGetId([
            'student_id'   => $validated['student_id'],
            'document_id'  => $validated['document_id'],
            'purpose'      => $validated['purpose'] ?? null,
            'date_request' => now(),

            'contact_number'        => $validated['contact_number'] ?? null,
            'is_graduate'           => $validated['is_graduate'] ?? null,
            'graduate_year'         => $validated['graduate_year'] ?? null,
            'last_semester'         => $validated['last_semester'] ?? null,
            'last_sy_start'         => $validated['last_sy_start'] ?? null,
            'last_sy_end'           => $validated['last_sy_end'] ?? null,
            'requested_before'      => $validated['requested_before'] ?? null,
            'previous_credential'   => $validated['previous_credential'] ?? null,
            'previous_request_date' => $validated['previous_request_date'] ?? null,
            'is_cleared'            => $validated['is_cleared'] ?? null,

            'agency'                => $validated['agency'] ?? null,
            'agency_other'          => $validated['agency_other'] ?? null,
            'certification_type'    => $validated['certification_type'] ?? null,
            'certification_other'   => $validated['certification_other'] ?? null,
            'subject_semester'      => $validated['subject_semester'] ?? null,
            'subject_sy_start'      => $validated['subject_sy_start'] ?? null,
            'subject_sy_end'        => $validated['subject_sy_end'] ?? null,
        ], 'request_id');

        foreach ($validated['documents'] as $docId) {
            DB::table('tbl_request_document')->insert([
                'request_id'  => $requestId,
                'document_id' => $docId,
                'status'      => 'Pending',
            ]);
        }

        return response()->json([
            'message'    => 'Request submitted successfully',
            'request_id' => $requestId,
        ], 201);
    }
}