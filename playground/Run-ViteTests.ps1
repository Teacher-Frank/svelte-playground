<#
.SYNOPSIS
Runs the playground Vitest unit test suite from PowerShell.

.DESCRIPTION
This script wraps the existing npm-based Vitest runner for the playground project.
It defaults to a single run with verbose failure output, raw console logging, and
console stack traces. Common Vitest options are exposed as PowerShell-style
parameters, and any uncommon options can still be passed through as additional
arguments.

.PARAMETER Watch
Runs Vitest in watch mode instead of appending --run.

.PARAMETER Reporter
Sets the Vitest reporter.

.PARAMETER DisableConsoleIntercept
Controls whether Vitest intercepts console output.

.PARAMETER PrintConsoleTrace
Controls whether Vitest prints console stack traces.

.PARAMETER Project
Runs one or more named Vitest projects.

.PARAMETER AdditionViteArgument
Additional arguments passed through to Vitest.

.EXAMPLE
./Run-ViteTests.ps1
Runs the full test suite once.

.EXAMPLE
./Run-ViteTests.ps1 -Watch
Starts Vitest in watch mode.

.EXAMPLE
./Run-ViteTests.ps1 -Project server
Runs only the server Vitest project.

.EXAMPLE
./Run-ViteTests.ps1 -Reporter dot -DisableConsoleIntercept:$false
Runs the suite with a dot reporter and default console interception behavior.

.EXAMPLE
./Run-ViteTests.ps1 -AdditionViteArgument '--testNamePattern=greet'
Passes an additional Vitest argument through to run only matching tests.

.NOTES
Use Get-Help ./Run-ViteTests.ps1 -Detailed for more information.
#>
[CmdletBinding()]
param(
    [switch]$Watch,
    [ValidateSet('default', 'agent', 'blob', 'verbose', 'dot', 'json', 'tap', 'tap-flat', 'junit', 'tree', 'hanging-process', 'github-actions')]
    [string]$Reporter = 'verbose',
    [bool]$DisableConsoleIntercept = $true,
    [bool]$PrintConsoleTrace = $true,
    [string[]]$Project = @(),
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AdditionViteArgument = @()
)

$ErrorActionPreference = 'Stop'

try {
    $projectRoot = Split-Path -Parent $PSCommandPath

    if (-not $projectRoot) {
        throw 'Could not determine the script directory.'
    }

    $packageJsonPath = Join-Path $projectRoot 'package.json'
    if (-not (Test-Path $packageJsonPath)) {
        throw "Could not find package.json in '$projectRoot'."
    }

    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCommand) {
        throw 'npm is not available on PATH.'
    }

    # Build the Vitest CLI from PowerShell-style parameters first.
    $vitestCliArgs = @()

    if (-not $Watch) {
        $vitestCliArgs += '--run'
    }

    $vitestCliArgs += "--reporter=$Reporter"

    if ($DisableConsoleIntercept) {
        $vitestCliArgs += '--disableConsoleIntercept'
    }

    if ($PrintConsoleTrace) {
        $vitestCliArgs += '--printConsoleTrace'
    }

    foreach ($projectName in $Project) {
        if (-not [string]::IsNullOrWhiteSpace($projectName)) {
            $vitestCliArgs += "--project=$projectName"
        }
    }

    # Preserve a PowerShell-style escape hatch for less common Vitest options.
    if ($AdditionViteArgument.Count -gt 0) {
        $vitestCliArgs += $AdditionViteArgument
    }

    # Forward the assembled Vitest CLI arguments through the existing npm script.
    $commandArgs = @('run', 'test:unit')
    if ($vitestCliArgs.Count -gt 0) {
        $commandArgs += '--'
        $commandArgs += $vitestCliArgs
    }

    Push-Location $projectRoot
    try {
        # Invoke npm directly so PowerShell preserves the external process exit code.
        & $npmCommand.Source $commandArgs
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "Vitest exited with code $exitCode."
        }
    }
    finally {
        Pop-Location
    }

    exit 0
}
catch {
    # Normalize setup and execution failures into a single PowerShell error message.
    $message = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($message)) {
        $message = 'Run-ViteTests.ps1 failed for an unknown reason.'
    }

    Write-Error $message
    exit 1
}