<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document Request Rejected</title>
</head>
<body style="margin:0; padding:0; background-color:#f3f4f6; font-family:Arial, Helvetica, sans-serif; color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6; padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden; border:1px solid #e5e7eb;">

          <!-- Header -->
          <tr>
            <td style="background-color:#0A2342; padding:24px 32px; border-bottom:4px solid #D4A017;">
              <p style="margin:0; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#D4A017; font-weight:bold;">
                Office of the Registrar
              </p>
              <h1 style="margin:6px 0 0; font-size:20px; color:#ffffff; font-weight:bold;">
                USTP Registrar
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px; font-size:15px;">Dear <strong>{{ $studentName }}</strong>,</p>

              <p style="margin:0 0 20px; font-size:15px; line-height:1.6;">
                We regret to inform you that your document request
                <strong>{{ $displayId }}</strong> has been
                <strong style="color:#b91c1c;">rejected</strong>.
              </p>

              <!-- Rejected documents and reasons -->
              @foreach ($docs as $doc)
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px; border:1px solid #e5e7eb; border-radius:6px;">
                  <tr>
                    <td style="padding:12px 16px; background-color:#f9fafb; border-bottom:1px solid #e5e7eb;">
                      <p style="margin:0; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#6b7280; font-weight:bold;">
                        Document
                      </p>
                      <p style="margin:4px 0 0; font-size:15px; font-weight:bold; color:#0A2342;">
                        {{ $doc->document_name }}
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:14px 16px; background-color:#fef2f2; border-left:4px solid #b91c1c;">
                      <p style="margin:0 0 4px; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#b91c1c; font-weight:bold;">
                        Reason for rejection
                      </p>
                      <p style="margin:0; font-size:14px; line-height:1.6; color:#7f1d1d;">
                        {!! nl2br(e($doc->rejection_reason)) !!}
                      </p>
                    </td>
                  </tr>
                </table>
              @endforeach

              <p style="margin:24px 0 16px; font-size:15px; line-height:1.6;">
                Please submit the missing requirement to the Registrar's Office, then file a new request.
                You may also check the status of your requests on the <strong>Track Requests</strong> page
                using your Student ID.
              </p>

              <p style="margin:24px 0 0; font-size:15px; line-height:1.6;">
                Respectfully yours,<br>
                <strong>USTP Registrar's Office</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb; padding:16px 32px; border-top:1px solid #e5e7eb;">
              <p style="margin:0; font-size:12px; color:#9ca3af; line-height:1.5;">
                This is an automated message from the USTP Registrar's Office. Please do not reply directly to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>