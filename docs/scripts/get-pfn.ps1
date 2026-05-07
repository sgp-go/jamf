# Microsoft PFN publisher hash 算法（UTF-16LE → SHA-256 → first 8 bytes (64 bits)
# → base32 with custom alphabet "0123456789abcdefghjkmnpqrstvwxyz"）
$publisher = 'CN=Aspira-MDM-Test, O=Aspira, C=TW'
$identityName = 'AspiraMDM.Demo'

$bytes = [System.Text.Encoding]::Unicode.GetBytes($publisher)
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash($bytes)
$first8 = $hash[0..7]
# 转成 64 bit binary string
$binStr = ''
foreach ($b in $first8) {
    $binStr += [Convert]::ToString($b, 2).PadLeft(8, '0')
}
# 65 bits（pad 1 bit at end），13 chars × 5 bits = 65 bits
$binStr += '0'
$alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
$result = ''
for ($i = 0; $i -lt 65; $i += 5) {
    $chunk = $binStr.Substring($i, 5)
    $idx = [Convert]::ToInt32($chunk, 2)
    $result += $alphabet[$idx]
}
Write-Output ('PFN: ' + $identityName + '_' + $result)
