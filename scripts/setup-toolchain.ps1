<#
.SYNOPSIS
    Prepare a Windows GNU Rust toolchain capable of building this project.

.DESCRIPTION
    Building on `x86_64-pc-windows-gnu` needs more than `rustup target add`.
    Two dependencies ship C code:

      * `ring`   - the TLS backend behind rustls
      * `mimalloc` - the allocator

    So the linker must be a real GCC, not rustc's bundled rust-lld. This script
    fetches w64devkit, a portable MinGW-w64 GCC that bundles gcc, binutils and
    make in a single archive, installs it under `.toolchain/`, applies the one
    patch GCC 16 needs, and prints the PATH line to use for the session.

    Everything lands inside the repository, so the install is self-contained and
    deletable. Nothing is written to `%ProgramFiles%` or `%LOCALAPPDATA%`.

.PARAMETER Version
    w64devkit release to install. Pinned because a newer GCC can change the
    unwinder layout the patch below compensates for.

.PARAMETER Arch
    Which w64devkit build to fetch. Must match the host architecture: rustc
    rejects a 32-bit linker for an x86_64 target.

.PARAMETER Force
    Reinstall even if the toolchain already looks present.

.EXAMPLE
    .\scripts\setup-toolchain.ps1
    # then, in the same shell:
    $env:Path = "$PWD\.toolchain\w64devkit\bin;$env:Path"
    cargo build
#>
[CmdletBinding()]
param(
    [string]$Version = 'v2.10.0',
    [ValidateSet('x64', 'x86')]
    [string]$Arch = 'x64',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$InstallDir = Join-Path $RepoRoot '.toolchain'
$ToolDir = Join-Path $InstallDir 'w64devkit'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "    $Message" -ForegroundColor Green
}

function Write-Note([string]$Message) {
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Save-RemoteFile {
    <#
        .SYNOPSIS
            Download $Url to $Destination, resuming and retrying as needed.
    #>
    param(
        [Parameter(Mandatory)] [string]$Url,
        [Parameter(Mandatory)] [string]$Destination,
        [int]$Attempts = 3
    )

    # Prefer curl.exe. It ships with Windows 10 1803 and later, follows GitHub's
    # redirect to the blob store, streams to disk, and resumes a partial file.
    #
    # Invoke-WebRequest is the last resort, not the first choice, and the reason
    # is worth recording: on PowerShell 5.1 it goes through HttpWebRequest,
    # which routinely drops a ~100 MB redirected download mid-transfer with
    # "The request was aborted: The connection was closed unexpectedly", and it
    # buffers the whole body in memory before writing. The first version of this
    # script used it and failed on a good connection.
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if ($attempt -gt 1) {
            Write-Note "retry $attempt of $Attempts after a partial download"
        }

        if ($curl) {
            # -f  fail on an HTTP error instead of writing the error page
            # -s  no progress meter
            # -S  but still report real errors
            # -L  follow redirects
            # -C -  resume from whatever is already on disk
            # --retry  handles transient drops within one invocation too
            #
            # The flags and the preference dance below are both required.
            # Windows PowerShell turns *any* native command writing to stderr
            # into a terminating NativeCommandError while
            # `$ErrorActionPreference` is 'Stop', and curl's progress meter is
            # on stderr - so without `-s` a perfectly good download aborts the
            # script on its first progress tick.
            $savedPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                $output = & $curl.Source -fsSL --retry 3 --retry-delay 2 -C - `
                    -o $Destination $Url 2>&1
                $exitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $savedPreference
            }

            if ($exitCode -eq 0) {
                Write-Ok ("downloaded {0:N1} MB" -f ((Get-Item $Destination).Length / 1MB))
                return
            }

            # 33 = server does not support resume; restart cleanly rather than
            # appending to a file curl cannot continue.
            if ($exitCode -eq 33) {
                Write-Note 'server refused a ranged request; restarting the download'
                Remove-Item $Destination -ErrorAction SilentlyContinue
            }
            else {
                Write-Note "curl exit $exitCode - $($output | Select-Object -Last 1)"
            }
            continue
        }

        # HttpClient: follows redirects and streams, unlike Invoke-WebRequest.
        # Windows PowerShell 5.1 does not load this assembly by default.
        Add-Type -AssemblyName System.Net.Http
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.AllowAutoRedirect = $true
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromMinutes(10)
        try {
            $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).
                GetAwaiter().GetResult()
            $response.EnsureSuccessStatusCode() | Out-Null

            $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $target = [IO.File]::Create($Destination)
            try {
                $source.CopyTo($target)
            }
            finally {
                $target.Dispose()
                $source.Dispose()
            }

            Write-Ok ("downloaded {0:N1} MB" -f ((Get-Item $Destination).Length / 1MB))
            return
        }
        catch {
            Write-Note "HttpClient: $($_.Exception.Message)"
        }
        finally {
            $client.Dispose()
            $handler.Dispose()
        }
    }

    throw "could not download $Url after $Attempts attempts. Check connectivity, or fetch the file manually and place it at $Destination."
}

# --------------------------------------------------------------------------
# 1. rustup and the pinned toolchain
# --------------------------------------------------------------------------

Write-Step 'Checking rustup'

$rustup = Get-Command rustup -ErrorAction SilentlyContinue
if (-not $rustup) {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe'
    if (Test-Path $cargoBin) {
        $rustup = $cargoBin
        Write-Note "rustup not on PATH; using $cargoBin"
    }
    else {
        throw 'rustup not found. Install it from https://rustup.rs and re-run this script.'
    }
}

# The repository pins its channel in rust-toolchain.toml, so plain `rustup show`
# is enough to install it - and installing whatever is pinned here is exactly
# what we want, rather than whatever happens to be the user's default.
& $rustup show 2>&1 | ForEach-Object { Write-Note $_ }

# Read the host from the *active toolchain name* (`stable-x86_64-pc-windows-gnu`)
# rather than from `rustup show`'s "Default host" line. The two disagree here -
# the user's global default is msvc while the repo overrides it to gnu - and the
# override is the one that decides how this project builds.
#
# Not named `$host`: that is a read-only automatic variable in PowerShell, and
# assigning to it is a terminating error rather than a shadow.
$activeToolchain = (& $rustup show active-toolchain 2>&1 | Select-Object -First 1).ToString()
if ($activeToolchain -notmatch 'x86_64-pc-windows-gnu') {
    throw @"
This script only sets up the windows-gnu toolchain, but rust-toolchain.toml
pins: $activeToolchain

Expected a toolchain whose name ends in x86_64-pc-windows-gnu.
"@
}
Write-Ok "toolchain: $activeToolchain"

# --------------------------------------------------------------------------
# 2. w64devkit
# --------------------------------------------------------------------------

$gccExe = Join-Path $ToolDir 'bin\gcc.exe'
$needsInstall = $Force -or -not (Test-Path $gccExe)

# The release *tag* carries a `v` prefix; the asset *filename* does not. Building
# the name from the tag is the easy mistake - it 404s, and curl reports that
# plainly enough to look like a network fault rather than a typo.
$VersionNumber = $Version.TrimStart('v', 'V')
$assetName = "w64devkit-$Arch-$VersionNumber.7z.exe"

if ($needsInstall) {
    Write-Step "Installing w64devkit $Version ($Arch) into .toolchain\"

    if ($Force -and (Test-Path $InstallDir)) {
        Write-Note 'removing the previous install (-Force)'
        Remove-Item -Recurse -Force $InstallDir
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    $archive = Join-Path $InstallDir $assetName
    if (-not (Test-Path $archive)) {
        $url = "https://github.com/skeeto/w64devkit/releases/download/$Version/$assetName"
        Write-Note "downloading $url"
        Save-RemoteFile -Url $url -Destination $archive
    }
    else {
        Write-Note 'archive already downloaded'
    }

    # The release ships a 7-Zip self-extractor. `Expand-Archive` and `tar` both
    # refuse it - bsdtar reports "LZMA codec is unsupported" - so the extractor
    # runs itself. `-y` overwrites, and `-o` has no space before the directory.
    Write-Note 'extracting'
    # Same stderr trap as the download: the extractor prints progress on stderr,
    # which `ErrorActionPreference = 'Stop'` would turn into a thrown error.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $archive -y "-o$InstallDir" 2>&1 | Out-Null
        $extractExit = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedPreference
    }

    if ($extractExit -ne 0) {
        throw "w64devkit self-extractor failed with exit code $extractExit"
    }

    if (-not (Test-Path $gccExe)) {
        throw "extraction finished but no gcc.exe at $gccExe"
    }
}
else {
    Write-Step 'w64devkit already present (pass -Force to reinstall)'
}

# --------------------------------------------------------------------------
# 3. The libgcc_eh.a patch
# --------------------------------------------------------------------------

# GCC 11 merged libgcc_eh.a into libgcc.a, but rustc's windows-gnu link line
# still passes `-lgcc_eh` unconditionally. Without a file of that name, every
# link fails with "cannot find -lgcc_eh" - even though the unwinder it wants is
# already inside libgcc.a.
#
# `unwind-seh.o` in the merged archive defines every `_Unwind_*` symbol that
# libgcc_eh.a used to provide, so a copy is an exact substitute.
Write-Step 'Patching libgcc_eh.a'

$libGcc = Join-Path $ToolDir 'lib\gcc\x86_64-w64-mingw32'
$libGccDir = Get-ChildItem -Path $libGcc -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1

if (-not $libGccDir) {
    throw "could not find the libgcc directory under $libGcc"
}

$gccDir = $libGccDir.FullName
$libgccEh = Join-Path $gccDir 'libgcc_eh.a'
$libgcc = Join-Path $gccDir 'libgcc.a'

if (-not (Test-Path $libgcc)) {
    throw "libgcc.a missing at $libgcc - the w64devkit archive looks damaged"
}

if (Test-Path $libgccEh) {
    Write-Ok "already present ($(Split-Path $gccDir -Leaf))"
}
else {
    Copy-Item $libgcc $libgccEh
    Write-Ok "copied libgcc.a -> libgcc_eh.a ($(Split-Path $gccDir -Leaf))"
}

# --------------------------------------------------------------------------
# 4. Verify, then hand back the PATH
# --------------------------------------------------------------------------

Write-Step 'Verifying'

$env:Path = "$(Join-Path $ToolDir 'bin');$env:Path"

$gccVersion = (& gcc --version 2>&1 | Select-Object -First 1)
Write-Ok $gccVersion

$env:CC_x86_64_pc_windows_gnu = 'gcc'
$env:AR_x86_64_pc_windows_gnu = 'ar'

# A real link of a C object is the only check that proves gcc, ar, windres and
# the CRT are all mutually consistent. Compiling and linking one file exercises
# every part of the chain that a Rust build will later depend on.
$probeDir = Join-Path $env:TEMP "mb-toolchain-probe-$PID"
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
try {
    $probe = Join-Path $probeDir 'probe.c'
    @'
#include <stdio.h>
int main(void) { printf("ok\n"); return 0; }
'@ | Set-Content -Path $probe -Encoding ascii

    & gcc $probe -o (Join-Path $probeDir 'probe.exe') 2>&1 |
        ForEach-Object { Write-Note $_ }
    if ($LASTEXITCODE -ne 0) {
        throw 'a trivial C program failed to compile and link, so a Rust build would fail too'
    }

    # gcc prints warnings to stderr, which `Stop` would turn into a thrown error.
    $ErrorActionPreference = 'Continue'
    $out = & (Join-Path $probeDir 'probe.exe')
    $ErrorActionPreference = 'Stop'

    if ($out -ne 'ok') {
        throw "the probe binary ran but printed '$out'"
    }
    Write-Ok 'C toolchain compiles, links and runs'
}
finally {
    Remove-Item -Recurse -Force $probeDir -ErrorAction SilentlyContinue
}

$binPath = Join-Path $ToolDir 'bin'
Write-Host ''
Write-Host 'Toolchain ready.' -ForegroundColor Green
Write-Host ''
Write-Host 'Add this to PATH for the build session:' -ForegroundColor Cyan
# A backtick escapes the `$` so PowerShell prints it literally. There must be no
# backtick immediately before the closing quote - that would escape the quote
# instead and swallow the rest of the script.
Write-Host "  `$env:Path = '$binPath';" -ForegroundColor White
Write-Host ''
Write-Note 'The PATH change does not persist past this shell. To make it permanent:'
Write-Host "  [Environment]::SetEnvironmentVariable('Path', '$binPath;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')" -ForegroundColor DarkGray
Write-Host ''
# Single-quoted: a backtick inside double quotes is an escape character in
# PowerShell and would be swallowed, leaving the reader with a bare `gcc`.
Write-Note '`.cargo/config.toml` already points cargo at gcc, so no further'
Write-Note 'configuration is needed once gcc is on PATH.'
