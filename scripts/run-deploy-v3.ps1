# Securely prompt for DEPLOYER_PK and run the v3 deployment.
# Usage:  ! .\scripts\run-deploy-v3.ps1
# The PK is read with Read-Host -AsSecureString so it is never echoed to the
# screen or saved to PowerShell history.

$ErrorActionPreference = "Stop"

# 1. Prompt for the private key without echoing it.
$secure = Read-Host -Prompt "Enter DEPLOYER_PK (hex, 0x... or raw)" -AsSecureString
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $pk = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

if ([string]::IsNullOrWhiteSpace($pk)) {
    Write-Error "No private key entered. Aborting."
    exit 1
}

# 2. Set env vars for this process only.
$env:DEPLOYER_PK  = $pk
$env:OUT_FILE     = "deployments/xlayer-testnet-v3.json"
$env:CHAIN_LABEL  = "xlayer-testnet-v3"
$env:RPC_URL      = "https://testrpc.xlayer.tech/terigon"

# 3. Run the deploy script.
Write-Host "Launching deploy.js (RPC=$($env:RPC_URL))..."
node scripts/deploy.js
$code = $LASTEXITCODE

# 4. Clear PK from this scope. (The parent shell never saw it.)
Remove-Variable pk -ErrorAction SilentlyContinue
$env:DEPLOYER_PK = $null

exit $code
