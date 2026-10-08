# Check DNS
nslookup choosealicense.com
dig choosealicense.com

# Test connectivity
ping choosealicense.com
curl https://choosealicense.com
