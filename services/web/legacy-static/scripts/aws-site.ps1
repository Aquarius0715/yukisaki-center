param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('on','off')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$Bucket
)

if ($Mode -eq 'on') {
  Write-Host "Enabling static site hosting for s3://$Bucket"
  aws s3 website "s3://$Bucket" --index-document index.html --error-document index.html | Out-Null
  $policy = @{
    Version = '2012-10-17'
    Statement = @(
      @{
        Sid = 'PublicReadGetObject'
        Effect = 'Allow'
        Principal = '*'
        Action = 's3:GetObject'
        Resource = "arn:aws:s3:::$Bucket/*"
      }
    )
  } | ConvertTo-Json -Depth 5
  aws s3api put-bucket-policy --bucket $Bucket --policy $policy | Out-Null
  Write-Host 'AWS static site hosting is ON.'
}
else {
  Write-Host "Disabling public site hosting for s3://$Bucket"
  aws s3api delete-bucket-policy --bucket $Bucket | Out-Null
  Write-Host 'AWS static site hosting is OFF.'
}
