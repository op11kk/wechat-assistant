# Video collector API smoke test. Run from repo root: .\scripts\mock_video_collector.ps1
# Requires: schema_video_collector.sql, npm run dev
# If API_SECRET set in .env, run: $env:API_SECRET='<same as .env>'

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$DefaultPort = "3000"
if (Test-Path (Join-Path $PSScriptRoot "..\.env")) {
    $lp = Select-String -Path (Join-Path $PSScriptRoot "..\.env") -Pattern '^PORT=' | Select-Object -First 1
    if ($lp) { $DefaultPort = ($lp.Line -replace '^PORT=', '').Trim() }
}
$Base = if ($env:BASE) { $env:BASE } else { "http://127.0.0.1:$DefaultPort" }
$OpenId = if ($env:MOCK_OPENID) { $env:MOCK_OPENID } else { "oMock-{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss"), (Get-Random) }

$Headers = @{ "Content-Type" = "application/json" }
if ($env:API_SECRET) {
    $Headers["Authorization"] = "Bearer $($env:API_SECRET)"
}

function Get-CurlAuthArgs {
    if ($env:API_SECRET) { return @("-H", "Authorization: Bearer $($env:API_SECRET)") }
    return @()
}

# PS 7+ 常把 4xx/5xx 正文放在 ErrorDetails；PS 5.1 多在 Response 流里
function Read-WebErrorBody {
    param([System.Management.Automation.ErrorRecord]$Err)
    if ($Err.ErrorDetails -and $Err.ErrorDetails.Message) {
        return $Err.ErrorDetails.Message
    }
    $resp = $Err.Exception.Response
    if ($resp -and $resp.GetResponseStream) {
        try {
            $stream = $resp.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                $txt = $reader.ReadToEnd()
                $reader.Dispose()
                if ($txt) { return $txt }
            }
        } catch { }
    }
    return $Err.Exception.Message
}

function Invoke-Json {
    param([string]$Method, [string]$Uri, $Body = $null)
    $params = @{ Uri = $Uri; Method = $Method; Headers = $Headers }
    if ($null -ne $Body) { $params["Body"] = ($Body | ConvertTo-Json -Compress -Depth 10) }
    try {
        $r = Invoke-WebRequest @params -UseBasicParsing
        Write-Host "HTTP $($r.StatusCode)"
        if ($r.Content) { $r.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10 }
    } catch {
        $status = $null
        try {
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        } catch { }
        Write-Host $(if ($null -ne $status) { "HTTP $status" } else { "HTTP (error)" })
        Write-Host (Read-WebErrorBody $_)
    }
}

Write-Host "==> BASE=$Base OPENID=$OpenId`n"

Write-Host "==> GET /health"
curl.exe -sS "$Base/health"
Write-Host "`n"

Write-Host "==> POST /participants"
$reg = @{
    wechat_openid = $OpenId
    real_name     = "MockUser"
    phone         = "13800138000"
}
$code = $null
try {
    $regJson = $reg | ConvertTo-Json -Compress
    $pr = Invoke-WebRequest -Uri "$Base/participants" -Method POST -Headers $Headers -Body $regJson -UseBasicParsing
    Write-Host "HTTP $($pr.StatusCode)"
    $regObj = $pr.Content | ConvertFrom-Json
    $regObj | ConvertTo-Json -Depth 10
    $code = $regObj.participant.participant_code
} catch {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 409) {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        Write-Host "HTTP 409 (exists)"
        Write-Host $body
        $regObj = $body | ConvertFrom-Json
        if ($regObj.participant) { $code = $regObj.participant.participant_code }
    } else {
        if ($resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            Write-Host "HTTP $([int]$resp.StatusCode)"
            Write-Host $reader.ReadToEnd()
        } else { throw $_ }
    }
}
if (-not $code) {
    Write-Host "==> GET /participants/by_openid (resolve code)"
    try {
        $g = Invoke-WebRequest -Uri "$Base/participants/by_openid?wechat_openid=$([Uri]::EscapeDataString($OpenId))" -Headers $Headers -UseBasicParsing
        $go = $g.Content | ConvertFrom-Json
        $code = $go.participant.participant_code
        Write-Host "HTTP $($g.StatusCode)"
        $go | ConvertTo-Json -Depth 10
    } catch {
        Write-Host "Could not resolve participant_code. Stop."
        exit 1
    }
}
if ($env:MOCK_CODE) { $code = $env:MOCK_CODE }
Write-Host "`n==> Using participant_code=$code"

Write-Host "==> GET /participants/by_openid"
& curl.exe -sS @(Get-CurlAuthArgs) "$Base/participants/by_openid?wechat_openid=$([Uri]::EscapeDataString($OpenId))"
Write-Host "`n"

Write-Host "==> POST /upload/presign"
$presignBody = @{
    participant_code = $code
    wechat_openid   = $OpenId
    content_type    = "video/mp4"
}
$objectKeyFromPresign = $null
try {
    $pb = $presignBody | ConvertTo-Json -Compress
    $prSign = Invoke-WebRequest -Uri "$Base/upload/presign" -Method POST -Headers $Headers -Body $pb -UseBasicParsing
    Write-Host "HTTP $($prSign.StatusCode)"
    $presignObj = $prSign.Content | ConvertFrom-Json
    $presignObj | ConvertTo-Json -Depth 10
    $objectKeyFromPresign = $presignObj.object_key
} catch {
    $resp = $_.Exception.Response
    if ($resp) {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        Write-Host "HTTP $([int]$resp.StatusCode)"
        Write-Host $reader.ReadToEnd()
    } else { throw $_ }
}
Write-Host ""

Write-Host "==> POST /upload/complete"
$okKey = if ($objectKeyFromPresign) { $objectKeyFromPresign } else { "uploads/$code/mock-$(Get-Random).mp4" }
$sub = @{
    participant_code = [string]$code
    wechat_openid   = $OpenId
    source          = "h5"
    object_key      = [string]$okKey
    file_name       = "mock.mp4"
    size_bytes      = 1024
    mime            = "video/mp4"
    user_comment    = "$code+video1"
}
Invoke-Json POST "$Base/upload/complete" $sub
Write-Host ""

Write-Host "==> GET /admin/submissions"
& curl.exe -sS @(Get-CurlAuthArgs) "$Base/admin/submissions?limit=10"
Write-Host "`n"

Write-Host "Done. 401: set `$env:API_SECRET to match .env. 503 presign: fill CLOUDFLARE_R2_* in .env and restart app."
Write-Host "500 /upload/complete: read response JSON `"detail`" (often RLS: use service_role key in SUPABASE_KEY or relax policies)."
Write-Host "BASE: 默认读 .env 的 PORT；可覆盖：`$env:BASE='http://127.0.0.1:3000'"
