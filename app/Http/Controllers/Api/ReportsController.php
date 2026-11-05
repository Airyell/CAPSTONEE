<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ReportsController extends Controller
{
    /**
     * GET /api/reports
     * Returns all data needed by SystemReports.jsx in one request.
     */
    public function index(Request $request)
    {
        $year = $request->query('year', now()->year);

        return response()->json([
            'stats'                => $this->getStats(),
            'monthlyTrends'        => $this->getMonthlyTrends($year),
            'mostStoredCredentials'    => $this->getMostStoredCredentials(),
            'mostRequestedCredentials' => $this->getMostRequestedCredentials(),
        ]);
    }

    /**
     * GET /api/reports/archived-logs?year=2026
     * ADDED: returns rows from tbl_system_activity for the selected year.
     */
    public function archivedLogs(Request $request)
    {
        $year = (int) $request->query('year', now()->year);

        $logs = DB::table('tbl_system_activity as a')
            ->leftJoin('tbl_staff as s', 's.staff_id', '=', 'a.staff_id')
            ->selectRaw('a.activity_id, a.activity_type, a.activity_description, a.date_time, a.staff_id, COALESCE(s.name, s.username) AS staff_name')
            ->whereRaw('EXTRACT(YEAR FROM a.date_time) = ?', [$year])
            ->where(function ($q) { // CHANGED: hide Admin activity
                $q->whereNull('s.user_role')
                  ->orWhere('s.user_role', '!=', 'Admin');
            })
            ->orderByDesc('a.date_time')
            ->get()
            ->map(fn($row) => [
                'id'      => $row->activity_id,
                'message' => $row->activity_description ?: $row->activity_type,
                'user'    => $row->staff_name ?? ('Staff #' . $row->staff_id),
                'date'    => $row->date_time,
            ])
            ->values();

        return response()->json($logs);
    }

    // ── STAT CARDS ────────────────────────────────────────────────────

    private function getStats(): array
    {
        // Total students
        $totalStudents = DB::table('tbl_student')->count();

        // Students added this month
        // tbl_student has no created_at, so we skip the "+X this month" sub for students
        // and just show total

        // Total credentials archived (all uploaded documents)
        $totalCredentials = DB::table('tbl_student_documents')->count();

        // Last upload time
        $lastUpload = DB::table('tbl_student_documents')
            ->orderByDesc('date_uploaded')
            ->value('date_uploaded');
        $lastUploadSub = $lastUpload
            ? 'Last: ' . \Carbon\Carbon::parse($lastUpload)->diffForHumans()
            : 'No uploads yet';

        // Completed requests
        $completedRequests = DB::table('tbl_request_document')
            ->whereRaw('LOWER(status) = ?', ['completed']) // CHANGED: case-insensitive ("Completed" is what the app saves)
            ->count();

        // Resolution rate = completed / total requests
        $totalRequests = DB::table('tbl_request_document')->count();
        $resolutionRate = $totalRequests > 0
            ? round(($completedRequests / $totalRequests) * 100, 1)
            : 0;

        // Active registrar staff (no status column, so total staff count)
        $totalStaff = DB::table('tbl_staff')
        ->where('user_role', '!=', 'Admin')
        ->where('status', 'Active')
        ->count();

        return [
            [
                'label' => 'Total Student Profiles',
                'value' => number_format($totalStudents),
                'sub'   => 'Total registered students',
            ],
            [
                'label' => 'Credentials Archived',
                'value' => number_format($totalCredentials),
                'sub'   => $lastUploadSub,
            ],
            [
                'label' => 'Completed Requests',
                'value' => number_format($completedRequests),
                'sub'   => $resolutionRate . '% resolution rate',
            ],
            [
                'label' => 'Active Registrar Staff',
                'value' => (string) $totalStaff,
                'sub'   => 'Currently logged in',
            ],
        ];
    }

    // ── MONTHLY UPLOAD TRENDS ─────────────────────────────────────────

    private function getMonthlyTrends(int $year): array
    {
        // Uploads per month from tbl_student_documents
        $uploads = DB::table('tbl_student_documents')
            ->selectRaw('EXTRACT(MONTH FROM date_uploaded)::int AS month, COUNT(*) AS total')
            ->whereRaw('EXTRACT(YEAR FROM date_uploaded) = ?', [$year])
            ->groupByRaw('EXTRACT(MONTH FROM date_uploaded)')
            ->pluck('total', 'month');

        // Requests per month from tbl_request
        $requests = DB::table('tbl_request')
            ->selectRaw('EXTRACT(MONTH FROM date_request)::int AS month, COUNT(*) AS total')
            ->whereRaw('EXTRACT(YEAR FROM date_request) = ?', [$year])
            ->groupByRaw('EXTRACT(MONTH FROM date_request)')
            ->pluck('total', 'month');

        // Build array for all 12 months
        $trends = [];
        for ($m = 1; $m <= 12; $m++) {
            $trends[] = [
                'uploads'  => (int) ($uploads[$m] ?? 0),
                'requests' => (int) ($requests[$m] ?? 0),
            ];
        }

        return $trends;
    }

    // ── MOST STORED CREDENTIALS ───────────────────────────────────────

    private function getMostStoredCredentials(): array
    {
        return DB::table('tbl_student_documents')
            ->selectRaw('document_name, COUNT(*) AS value')
            ->groupBy('document_name')
            ->orderByDesc('value')
            ->limit(8)
            ->get()
            ->map(fn($row) => [
                'label' => $row->document_name,
                'value' => (int) $row->value,
            ])
            ->toArray();
    }

    // ── MOST REQUESTED CREDENTIALS ────────────────────────────────────

    private function getMostRequestedCredentials(): array
    {
        return DB::table('tbl_request_document as rd')
            ->join('tbl_documents as d', 'd.document_id', '=', 'rd.document_id')
            ->selectRaw('d.document_name AS label, COUNT(*) AS value')
            ->groupBy('d.document_name')
            ->orderByDesc('value')
            ->limit(9)
            ->get()
            ->map(fn($row) => [
                'label' => $row->label,
                'value' => (int) $row->value,
            ])
            ->toArray();
    }
}