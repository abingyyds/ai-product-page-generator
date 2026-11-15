import { lookup } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

const [globalIPv6, globalIPv6Bits] = ipaddr.IPv6.parseCIDR("2000::/3");

export function isPublicProviderAddress(address: string) {
  const ip = ipaddr.process(address);
  return ip.range() === "unicast" && (!(ip instanceof ipaddr.IPv6) || ip.match(globalIPv6, globalIPv6Bits));
}

function publicAddressError() {
  return Object.assign(new Error("自定义模型服务仅允许公网地址"), { code: "EPERM" });
}

const publicDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, "", 0);
        if (!addresses.length || addresses.some(({ address }) => !isPublicProviderAddress(address))) {
          return callback(publicAddressError(), "", 0);
        }
        // Supply only the already validated DNS answers to the socket.
        if (options.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
      });
    },
  },
});

export function providerUrl(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("请输入有效的 HTTP(S) 服务地址");
  }
  return url.href.replace(/\/+$/, "");
}

export function assertPublicProviderUrl(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("请输入有效的 HTTP(S) 服务地址");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !isPublicProviderAddress(hostname)) {
    throw publicAddressError();
  }
}

export function fetchPublicProvider(url: string, init: RequestInit) {
  assertPublicProviderUrl(url);
  const options = { ...init, redirect: "error" as const, dispatcher: publicDispatcher };
  return fetch(url, options);
}
