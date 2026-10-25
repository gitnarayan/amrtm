$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
Write-Host 'Reset the LOCAL admin@example.com password. MFA remains enabled if previously configured.'
$firstSecret = Read-Host 'New password (15-128 characters)' -AsSecureString
$secondSecret = Read-Host 'Confirm new password' -AsSecureString
$firstPointer = [IntPtr]::Zero
$secondPointer = [IntPtr]::Zero
try {
    $firstPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($firstSecret)
    $secondPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secondSecret)
    $newPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPointer)
    $confirmation = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPointer)
    if ($newPassword -cne $confirmation) { throw 'Passwords do not match; nothing changed.' }
    if ($newPassword.Length -lt 15 -or $newPassword.Length -gt 128) { throw 'Password must be 15-128 characters; nothing changed.' }
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    @{ password = $newPassword } | ConvertTo-Json -Compress | node --env-file=.env --import tsx scripts/reset-local-admin.ts
    if ($LASTEXITCODE -ne 0) { throw 'Reset failed. Check the error above.' }
} finally {
    if ($firstPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPointer) }
    if ($secondPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPointer) }
    $newPassword = $null
    $confirmation = $null
    $firstSecret.Dispose()
    $secondSecret.Dispose()
}
