# Create .venv-docling and install the pinned Docling sidecar (Windows PowerShell).
#   powershell -ExecutionPolicy Bypass -File scripts\setup-docling.ps1
#   $env:PYTHON = "py -3.12"; powershell -File scripts\setup-docling.ps1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root ".venv-docling"
$PythonCmd = if ($env:PYTHON) { $env:PYTHON } else { "py -3" }
$PyParts = $PythonCmd -split " "
$PyExe = $PyParts[0]
$PyArgs = @()
if ($PyParts.Length -gt 1) { $PyArgs = $PyParts[1..($PyParts.Length - 1)] }

$Version = & $PyExe @PyArgs -c "import sys; print('%d.%d' % sys.version_info[:2])"
if (@("3.11", "3.12", "3.13") -notcontains $Version) {
    throw "Python 3.11-3.13 required (found $Version)."
}

$VenvPython = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    & $PyExe @PyArgs -m venv $Venv
}
& $VenvPython -m pip install --upgrade pip
# CPU torch wheels: the default index would pull CUDA builds (~3 GB).
& $VenvPython -m pip install --extra-index-url https://download.pytorch.org/whl/cpu -r (Join-Path $Root "py-sidecar\requirements-dev.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Push-Location (Join-Path $Root "py-sidecar")
try {
    & $VenvPython warmup.py
    if ($LASTEXITCODE -ne 0) { throw "OCR warm-up failed; see message above." }
} finally {
    Pop-Location
}
Write-Host "Done. Start the sidecar with:"
Write-Host "  .venv-docling\Scripts\uvicorn.exe --app-dir py-sidecar main:app --host 127.0.0.1 --port 5001"
