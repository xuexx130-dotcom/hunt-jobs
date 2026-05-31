const https = require('https');

async function getAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            resolve(parsed.access_token);
          } else {
            reject(new Error('No access token: ' + data));
          }
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function sendEmail(to, subject, bodyText, attachmentPath) {
  const accessToken = await getAccessToken();
  const fs = require('fs');
  const path = require('path');

  let emailLines = [
    `To: ${to}`,
    `From: Xue Ke <${process.env.GMAIL_SENDER || 'xuexx130@gmail.com'}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ];

  if (attachmentPath && fs.existsSync(attachmentPath)) {
    const boundary = 'boundary_huntjobs_' + Date.now();
    const filename = path.basename(attachmentPath);
    const fileData = fs.readFileSync(attachmentPath).toString('base64');
    
    emailLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    emailLines.push('');
    emailLines.push(`--${boundary}`);
    emailLines.push('Content-Type: text/plain; charset=utf-8');
    emailLines.push('');
    emailLines.push(bodyText);
    emailLines.push('');
    emailLines.push(`--${boundary}`);
    emailLines.push(`Content-Type: application/octet-stream; name="${filename}"`);
    emailLines.push('Content-Transfer-Encoding: base64');
    emailLines.push(`Content-Disposition: attachment; filename="${filename}"`);
    emailLines.push('');
    emailLines.push(fileData);
    emailLines.push(`--${boundary}--`);
  } else {
    emailLines.push('Content-Type: text/plain; charset=utf-8');
    emailLines.push('');
    emailLines.push(bodyText);
  }

  const raw = Buffer.from(emailLines.join('\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return new Promise((resolve, reject) => {
    const bodyData = JSON.stringify({ raw });
    const options = {
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.id) {
          console.log('Email sent, id:', result.id);
          resolve(result);
        } else {
          reject(new Error('Send failed: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyData);
    req.end();
  });
}

module.exports = { getAccessToken, sendEmail };
