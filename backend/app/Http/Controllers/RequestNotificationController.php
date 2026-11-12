<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

class RequestNotificationController extends Controller
{
    public function notifyRejection($requestId)
    {
        $req = DB::table('tbl_request as r')
            ->join('tbl_student as s', 's.student_id', '=', 'r.student_id')
            ->where('r.request_id', $requestId)
            ->select('r.request_id', 'r.date_request', 's.first_name', 's.last_name', 's.email')
            ->first();

        if (!$req) {
            return response()->json(['message' => 'Request not found.'], 404);
        }

        if (!$req->email) {
            return response()->json(['message' => 'This student has no email on file.'], 422);
        }

        $docs = DB::table('tbl_request_document as rd')
            ->join('tbl_documents as d', 'd.document_id', '=', 'rd.document_id')
            ->where('rd.request_id', $requestId)
            ->whereNotNull('rd.rejection_reason')
            ->where('rd.rejection_reason', '!=', '')
            ->select('d.document_name', 'rd.rejection_reason')
            ->get();

        if ($docs->isEmpty()) {
            return response()->json(['message' => 'No rejection reason found on this request.'], 422);
        }

        $displayId = sprintf('REQ-%s-%03d', date('Y', strtotime($req->date_request)), $req->request_id);
        $name = e(trim("{$req->first_name} {$req->last_name}"));

        $items = '';
        foreach ($docs as $doc) {
            $items .= '<p><strong>' . e($doc->document_name) . '</strong><br>'
                    . 'Reason: ' . e($doc->rejection_reason) . '</p>';
        }

        $html = "<p>Hello {$name},</p>"
              . "<p>Your request <strong>{$displayId}</strong> was rejected.</p>"
              . $items
              . "<p>Please submit the missing requirement to the Registrar's Office, then file a new request. "
              . "You can also check your status on the Track Requests page using your Student ID.</p>"
              . "<p>USTP Registrar</p>";

        try {
            $response = Http::withToken(config('services.resend.key'))
                ->post('https://api.resend.com/emails', [
                    'from'    => config('mail.from.name') . ' <' . config('mail.from.address') . '>',
                    'to'      => [$req->email],
                    'subject' => "Your document request {$displayId} was rejected",
                    'html'    => $html,
                ]);
        } catch (\Throwable $e) {
            report($e);
            return response()->json(['message' => 'Email could not be sent.'], 500);
        }

        if ($response->failed()) {
            report(new \RuntimeException('Resend error: ' . $response->body()));
            return response()->json([
                'message' => 'Email could not be sent.',
                'detail'  => $response->json(),
            ], 500);
        }

        return response()->json(['message' => 'Email sent.']);
    }
}