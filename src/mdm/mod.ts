/** 自建 MDM 模組匯出 */

export { handleCheckin } from "./checkin.ts";
export { handleCommandRequest, enqueueCommand } from "./command.ts";
export { parsePlist, buildPlist, bufferToHex, bufferToBase64 } from "./plist.ts";
export {
  getOrCreateCA,
  getCACertPem,
  getCACertDerBase64,
  issueDeviceCertificateP12,
  getOrCreateDepKeyPair,
  decryptDepToken,
  getApnsCertInfo,
  getApnsTopic,
  loadApnsCert,
  saveApnsCert,
  generateApnsCsr,
  APNS_CERT_PATH,
  APNS_KEY_PATH,
} from "./crypto.ts";
export { sendMdmPush, pushToDevice } from "./apns.ts";
export { generateEnrollmentProfile, generateAdeEnrollmentProfile } from "./enrollment.ts";
export {
  getDepAccount,
  fetchDepDevices,
  syncDepDevices,
  syncDevicesToDb,
  createDepProfile,
  assignDepProfile,
  removeDepProfile,
  getDepProfile,
  getDepDeviceDetails,
} from "./dep.ts";
export type * from "./types.ts";
