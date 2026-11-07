<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

class StudentController extends Controller
{
    /**
     * Base folder: C:\StudentRecords
     * Optional override in .env:  STUDENT_BASE_PATH="D:\SchoolRecords"
     */
    private function getBasePath(): string
    {
        $custom = env('STUDENT_BASE_PATH');
        if ($custom) {
            return rtrim($custom, '\\/');
        }

        return 'C:' . DIRECTORY_SEPARATOR . 'StudentRecords';
    }

    /** Make a value safe to use as one Windows folder name. */
    private function safeName(?string $value): string
    {
        $value = preg_replace('/[<>:"\/\\\\|?*\x00-\x1F]/', '_', (string) $value);
        $value = preg_replace('/\s+/', ' ', $value);
        $value = trim($value);
        $value = rtrim($value, '. ');

        return mb_substr($value, 0, 120);
    }

    private function buildFolderPath(array $student, ?string $collegeName): string
    {
        $fullName = $this->safeName(trim(
            ($student['first_name'] ?? '') . ' ' .
            ($student['middle_name'] ?? '') . ' ' .
            ($student['last_name'] ?? '')
        ));

        $studentFolder = $this->safeName($student['student_id']) . '_' .
            str_replace(' ', '_', $fullName);

        $collegeFolder = str_replace(' ', '_', $this->safeName($collegeName));
        if ($collegeFolder === '') {
            $collegeFolder = 'Unassigned';
        }

        // C:\StudentRecords\<College>\<ID>_<Name>
        return $this->getBasePath()
            . DIRECTORY_SEPARATOR . $collegeFolder
            . DIRECTORY_SEPARATOR . $studentFolder;
    }

    public function createStudentFolder(array $student, ?string $collegeName): string
    {
        $folderPath = $this->buildFolderPath($student, $collegeName);

        if (!File::isDirectory($folderPath)) {
            File::makeDirectory($folderPath, 0755, true);
        }

        if (!File::isDirectory($folderPath)) {
            throw new \RuntimeException("Could not create folder: {$folderPath}");
        }

        return $folderPath;
    }

    public function store(Request $request)
    {
        $validated = $request->validate([
            'student_id'     => 'required|digits_between:1,12|unique:tbl_student,student_id',
            'first_name'     => 'required|string|max:50',
            'middle_name'    => 'nullable|string|max:50',
            'last_name'      => 'required|string|max:50',
            'birthdate'      => 'nullable|date',
            'gender'         => 'nullable|string|max:10',
            'email'          => 'nullable|email|max:100',
            'contact_number' => 'nullable|string|max:20',
            'address'        => 'nullable|string',
            'college_id'     => 'required|integer|exists:tbl_college,college_id',
            'program_id'     => 'required|integer|exists:tbl_program,program_id',
            'year_level'     => 'required|integer|between:1,5',
            'status'         => 'required|string|max:20',
        ]);

        try {
            $collegeName = DB::table('tbl_college')
                ->where('college_id', $validated['college_id'])
                ->value('college_name');

            // Create the folder first, then save the student
            $folderPath = $this->createStudentFolder($validated, $collegeName);

            DB::transaction(function () use ($validated, $folderPath) {
                DB::table('tbl_student')->insert(
                    $validated + ['folder_path' => $folderPath]
                );
            });
        } catch (\Throwable $e) {
            return response()->json([
                'message' => 'Could not add the student: ' . $e->getMessage(),
            ], 500);
        }

        return response()->json([
            'message'     => 'Student added and folder created successfully.',
            'folder_path' => $folderPath,
        ], 201);
    }
}