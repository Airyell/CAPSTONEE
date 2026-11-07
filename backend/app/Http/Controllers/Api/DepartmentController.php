<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Support\Facades\DB;

class DepartmentController extends Controller
{
    // Full names for the short college codes stored in college_name.
    private const FULL_NAMES = [
        'CEA'  => 'College of Engineering & Architecture',
        'CITC' => 'College of IT & Computing',
        'CSM'  => 'College of Science & Mathematics',
        'CSTE' => 'College of Science & Technology Education',
        'COT'  => 'College of Technology',
        'COM'  => 'College of Medicine',
        'CON'  => 'College of Nursing',
        'SHS'  => 'Senior High School',
    ];

    private const REQUIRED_DOCS = 8; // matches the /8 used in the frontend

    // GET /api/colleges
    public function index()
    {
        $colleges = DB::table('tbl_college')->orderBy('college_name')->get();
        $programs = DB::table('tbl_program')->get()->groupBy('college_id');

        // Documents per student, capped at REQUIRED_DOCS for the completion %.
        $docCounts = DB::table('tbl_student_documents')
            ->select('student_id', DB::raw('COUNT(*) as docs'))
            ->groupBy('student_id')
            ->pluck('docs', 'student_id');

        $students = DB::table('tbl_student')
            ->select('student_id', 'college_id')
            ->get()
            ->groupBy('college_id');

        $result = $colleges->map(function ($c) use ($programs, $students, $docCounts) {
            $collegeStudents = $students->get($c->college_id, collect());
            $studentCount = $collegeStudents->count();

            $totalDocs = 0;
            $completionSum = 0;
            foreach ($collegeStudents as $s) {
                $n = (int) ($docCounts[$s->student_id] ?? 0);
                $totalDocs += $n;
                $completionSum += min($n, self::REQUIRED_DOCS) / self::REQUIRED_DOCS;
            }

            return [
                'college_id'      => $c->college_id,
                'college_name'    => $c->college_name,
                'full_name'       => self::FULL_NAMES[strtoupper($c->college_name)] ?? $c->college_name,
                'students_count'  => $studentCount,
                'documents_count' => $totalDocs,
                'completion'      => $studentCount ? (int) round(($completionSum / $studentCount) * 100) : 0,
                'programs'        => $programs->get($c->college_id, collect())
                    ->map(fn ($p) => [
                        'program_id'   => $p->program_id,
                        'program_name' => $p->program_name,
                    ])->values(),
            ];
        });

        return response()->json($result->values());
    }

    // GET /api/colleges/{collegeId}/students
    public function students($collegeId)
    {
        $docCounts = DB::table('tbl_student_documents')
            ->select('student_id', DB::raw('COUNT(*) as docs'))
            ->groupBy('student_id')
            ->pluck('docs', 'student_id');

        $students = DB::table('tbl_student')
            ->where('college_id', $collegeId)
            ->orderBy('last_name')
            ->get(['student_id', 'first_name', 'last_name', 'program_id', 'year_level'])
            ->map(function ($s) use ($docCounts) {
                $s->documents = (int) ($docCounts[$s->student_id] ?? 0);
                return $s;
            });

        return response()->json($students->values());
    }
}