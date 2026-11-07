<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

class OcrController extends Controller
{
    public function extract(Request $request)
    {
        $request->validate([
            'file' => 'required|file|mimes:jpg,jpeg,png,pdf|max:10240',
        ]);

        try {
            set_time_limit(600);

            $file = $request->file('file');

            // Send file directly to Flask OCR server
            $response = Http::timeout(600)
                ->attach(
                    'file',
                    file_get_contents($file->getRealPath()),
                    $file->getClientOriginalName()
                )
                ->post('http://127.0.0.1:5001/ocr');

            if (!$response->successful()) {
                return response()->json([
                    'success' => false,
                    'message' => 'OCR server error: ' . $response->body(),
                ], 500);
            }

            $result = $response->json();

            if (!$result || !($result['success'] ?? false)) {
                return response()->json([
                    'success' => false,
                    'message' => $result['message'] ?? 'OCR failed',
                ], 500);
            }

            return response()->json([
                'success'     => true,
                'first_name'  => $result['first_name'] ?? '',
                'last_name'   => $result['last_name'] ?? '',
                'middle_name' => $result['middle_name'] ?? '',

                // Birthdate extracted by Python OCR
                'birthdate'   => $result['birthdate']
                    ?? $result['birthday']
                    ?? '',

                'raw_text'    => $result['raw_text'] ?? '',
            ]);

        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
            ], 500);
        }
    }
}