import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { STATE_DIR, hostName, localAddresses } from "./net";

/**
 * A private certificate authority for the panel's HTTPS listener, so phones
 * can install the panel as a real PWA (service workers need a secure origin).
 *
 * The CA is name-constrained to private networks and .local names: even if its
 * key leaked, it could not mint a certificate for any public website.
 */
export const TLS_DIR = path.join(STATE_DIR, "tls");
const CA_KEY = path.join(TLS_DIR, "ca.key");
export const CA_CERT = path.join(TLS_DIR, "ca.crt");
const KEY = path.join(TLS_DIR, "server.key");
const CERT = path.join(TLS_DIR, "server.crt");
const SANS = path.join(TLS_DIR, "server.sans");

function openssl(args: string[], input?: string) {
  return execFileSync("openssl", args, { input, stdio: ["pipe", "pipe", "pipe"] }).toString();
}

function ensureCa() {
  if (existsSync(CA_KEY) && existsSync(CA_CERT)) return;
  const h = hostName();
  const cnf = `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=fleet panel on ${h}
O=fleet control panel
[ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
nameConstraints=critical,permitted;DNS:localhost,permitted;DNS:local,permitted;DNS:${h},permitted;IP:127.0.0.0/255.0.0.0,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:100.64.0.0/255.192.0.0
`;
  const cnfPath = path.join(TLS_DIR, "ca.cnf");
  writeFileSync(cnfPath, cnf);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", CA_KEY]);
  chmodSync(CA_KEY, 0o600);
  openssl(["req", "-x509", "-new", "-key", CA_KEY, "-sha256", "-days", "3650", "-config", cnfPath, "-out", CA_CERT]);
}

function wantedSans(extraIps: string[]): string[] {
  const h = hostName();
  const ips = new Set(["127.0.0.1", ...localAddresses().filter((a) => !a.includes(":")), ...extraIps]);
  return [`DNS:localhost`, `DNS:${h}`, `DNS:${h}.local`, ...[...ips].sort().map((ip) => `IP:${ip}`)];
}

function leafValidDays(): number {
  try {
    const end = openssl(["x509", "-in", CERT, "-noout", "-enddate"]).trim().replace("notAfter=", "");
    return (new Date(end).getTime() - Date.now()) / 86_400_000;
  } catch {
    return 0;
  }
}

/**
 * Makes sure a server certificate exists that covers this machine's current
 * names and addresses; reissues it when an address changes or it nears expiry.
 * Returns null when openssl isn't available.
 */
export function ensureCerts(extraIps: string[] = []): { key: Buffer; cert: Buffer; ca: Buffer } | null {
  try {
    mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
    ensureCa();
    const sans = wantedSans(extraIps);
    const have = existsSync(SANS) ? readFileSync(SANS, "utf8") : "";
    const covered = sans.every((s) => have.split(",").includes(s));
    if (!existsSync(CERT) || !covered || leafValidDays() < 30) {
      // keep previously seen addresses too, so a laptop moving between networks doesn't churn
      const merged = [...new Set([...have.split(",").filter(Boolean), ...sans])];
      const ext = path.join(TLS_DIR, "server.ext");
      writeFileSync(
        ext,
        `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${merged.join(",")}\n`,
      );
      openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", KEY]);
      chmodSync(KEY, 0o600);
      const csr = openssl(["req", "-new", "-key", KEY, "-subj", `/CN=${hostName()}.local`]);
      // 397 days: the longest lifetime Apple and Chrome accept for TLS server certificates
      const cert = openssl(
        ["x509", "-req", "-CA", CA_CERT, "-CAkey", CA_KEY, "-CAcreateserial", "-days", "397", "-sha256", "-extfile", ext],
        csr,
      );
      writeFileSync(CERT, cert + readFileSync(CA_CERT, "utf8"));
      writeFileSync(SANS, merged.join(","));
    }
    return { key: readFileSync(KEY), cert: readFileSync(CERT), ca: readFileSync(CA_CERT) };
  } catch (err) {
    console.warn("  ! HTTPS disabled — couldn't create certificates:", (err as Error).message.split("\n")[0]);
    return null;
  }
}
