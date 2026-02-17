const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const SITE_URL = process.env.APP_URL || 'http://localhost:3000';
const ADMIN_EMAIL = 'natehollidaynh@gmail.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Alpha Channel Media <onboarding@resend.dev>';

async function sendCreatorApplicationEmail(application) {
  const approveUrl = `${SITE_URL}/master-admin.html?action=approve&id=${application.id}`;
  const denyUrl = `${SITE_URL}/master-admin.html?action=deny&id=${application.id}`;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject: `New Creator Application: ${application.first_name} ${application.last_name}`,
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #1a1a1a; margin-bottom: 24px;">New Creator Application</h1>

          <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; margin-bottom: 32px;">
            <p><strong>Name:</strong> ${application.first_name} ${application.last_name}</p>
            <p><strong>Email:</strong> ${application.email}</p>
            <p><strong>Username:</strong> ${application.username}</p>
            <p><strong>Artist Name:</strong> ${application.artist_name || 'N/A'}</p>
            <p><strong>Bio:</strong> ${application.bio || 'N/A'}</p>
            <p><strong>Reason:</strong> ${application.reason || 'N/A'}</p>
          </div>

          <div style="text-align: center;">
            <a href="${approveUrl}" style="display: inline-block; padding: 14px 32px; background: #00a86b; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin-right: 16px;">APPROVE</a>
            <a href="${denyUrl}" style="display: inline-block; padding: 14px 32px; background: #d32f2f; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">DENY</a>
          </div>
        </div>
      `
    });
    console.log('Application notification email sent to admin');
  } catch (err) {
    console.error('Failed to send application email:', err);
  }
}

async function sendCreatorWelcomeEmail(application, password) {
  const loginUrl = `${SITE_URL}/login.html`;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: application.email,
      subject: `Your Alpha Channel Media Application Has Been Approved!`,
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #1a1a1a; margin-bottom: 16px;">Welcome to Alpha Channel Media!</h1>
          <p style="color: #666; margin-bottom: 32px;">Congratulations ${application.first_name}! Your creator application has been approved.</p>

          <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; margin-bottom: 32px;">
            <h3 style="margin-bottom: 16px;">Your Login Credentials</h3>
            <p><strong>Username:</strong> ${application.username}</p>
            <p><strong>Temporary Password:</strong> ${password}</p>
          </div>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${loginUrl}" style="display: inline-block; padding: 14px 32px; background: #00a86b; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">LOGIN NOW</a>
          </div>

          <h3 style="margin-bottom: 12px;">Next Steps:</h3>
          <ol style="color: #666; line-height: 1.8;">
            <li>Sign in with your credentials above</li>
            <li>Access the Creator Dashboard</li>
            <li>Upload your first track or video</li>
            <li>Share your music with the world!</li>
          </ol>
        </div>
      `
    });
    console.log('Welcome email sent to creator:', application.email);
  } catch (err) {
    console.error('Failed to send welcome email:', err);
  }
}

async function sendListenerConfirmationEmail(listener) {
  const loginUrl = `${SITE_URL}/login.html`;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: listener.email,
      subject: `Welcome to Alpha Channel Media!`,
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #1a1a1a; margin-bottom: 16px;">Welcome to Alpha Channel Media!</h1>
          <p style="color: #666; margin-bottom: 32px;">Hey ${listener.first_name}! Your listener account is all set up.</p>

          <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; margin-bottom: 32px;">
            <p><strong>Username:</strong> ${listener.username}</p>
            <p><strong>Email:</strong> ${listener.email}</p>
          </div>

          <div style="text-align: center;">
            <a href="${loginUrl}" style="display: inline-block; padding: 14px 32px; background: #00a86b; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">START LISTENING</a>
          </div>
        </div>
      `
    });
    console.log('Confirmation email sent to listener:', listener.email);
  } catch (err) {
    console.error('Failed to send listener confirmation email:', err);
  }
}

async function sendAdminListenerNotification(listener) {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject: `New Listener Signup: ${listener.first_name} ${listener.last_name}`,
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="color: #1a1a1a; margin-bottom: 24px;">New Listener Joined</h1>

          <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <p><strong>Name:</strong> ${listener.first_name} ${listener.last_name}</p>
            <p><strong>Email:</strong> ${listener.email}</p>
            <p><strong>Username:</strong> ${listener.username}</p>
          </div>

          <p style="color: #666; font-size: 0.9rem;">This account was automatically approved.</p>
        </div>
      `
    });
    console.log('Admin notification sent for new listener');
  } catch (err) {
    console.error('Failed to send admin listener notification:', err);
  }
}

module.exports = {
  sendCreatorApplicationEmail,
  sendCreatorWelcomeEmail,
  sendListenerConfirmationEmail,
  sendAdminListenerNotification
};
