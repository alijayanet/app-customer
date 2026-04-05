const crypto = require('crypto');

// In-memory store for OTPs (for simplicity)
// In production, use Redis or a DB with TTL
const otpStore = new Map();

/**
 * Generate 6-digit OTP and store it
 * @param {string} phone 
 * @returns {string} 
 */
function generateOtp(phone) {
  const otp = crypto.randomInt(1000, 9999).toString();
  otpStore.set(phone, {
    otp,
    expires: Date.now() + 5 * 60 * 1000 // 5 minutes
  });
  return otp;
}

/**
 * Verify OTP
 * @param {string} phone 
 * @param {string} inputOtp 
 * @returns {boolean} 
 */
function verifyOtp(phone, inputOtp) {
  const record = otpStore.get(phone);
  if (!record) return false;
  
  if (record.expires < Date.now()) {
    otpStore.delete(phone);
    return false;
  }
  
  if (record.otp === inputOtp) {
    otpStore.delete(phone);
    return true;
  }
  
  return false;
}

module.exports = {
  generateOtp,
  verifyOtp
};
