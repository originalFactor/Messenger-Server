/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 出站 URL 校验（SSRF 防护）。
 *
 * 上游 `baseUrl` 由管理员填写（探测/测试表单或已保存的上游），中继会带着
 * 上游密钥对它发 POST。若不校验，`http://169.254.169.254/` 或内网地址会
 * 让服务端替调用方访问内部资源（盲 SSRF / 端口扫描），并把上游密钥发给
 * 任意目标。
 *
 * 校验分两层：
 * 1. 静态：协议必须是 http(s)，主机名不能是明显的内部名（localhost 等）；
 * 2. 动态：DNS 解析后逐个 IP 检查，拒绝环回/私网/链路本地/CGNAT/ULA/
 *    组播/保留段，以及 IPv4-mapped IPv6 形式的同类地址。
 *
 * 注意：这不防御 DNS rebinding（解析与连接之间记录可被换掉）。要彻底防住
 * 需要自定义 undici dispatcher 把连接钉在已校验的 IP 上；当前实现覆盖了
 * 绝大多数误配置与内部地址探测。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** 出站 URL 被拒绝时抛出；路由层映射为 400。 */
export class BlockedUrlError extends Error {}

const BLOCKED_HOSTNAMES: Record<string, true> = {
  localhost: true,
  "localhost.localdomain": true,
  "ip6-localhost": true,
  "ip6-loopback": true,
  metadata: true,
  "metadata.google.internal": true,
};

/** IPv4 私有/保留段（CIDR 前缀用位运算判断，避免维护长正则）。 */
const BLOCKED_IPV4: Array<{ base: number; bits: number; label: string }> = [
  { base: 0x00000000, bits: 8, label: "0.0.0.0/8" },
  { base: 0x0a000000, bits: 8, label: "10.0.0.0/8" },
  { base: 0x64400000, bits: 10, label: "100.64.0.0/10" },
  { base: 0x7f000000, bits: 8, label: "127.0.0.0/8" },
  { base: 0xa9fe0000, bits: 16, label: "169.254.0.0/16" },
  { base: 0xac100000, bits: 12, label: "172.16.0.0/12" },
  { base: 0xc0000000, bits: 24, label: "192.0.0.0/24" },
  { base: 0xc0a80000, bits: 16, label: "192.168.0.0/16" },
  { base: 0xc6120000, bits: 15, label: "198.18.0.0/15" },
  { base: 0xe0000000, bits: 4, label: "224.0.0.0/4" },
  { base: 0xf0000000, bits: 4, label: "240.0.0.0/4" },
];

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) {
    return true;
  }
  return BLOCKED_IPV4.some(({ base, bits }) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

/** 把 IPv6 字面量展开成 8 个 hextet；非法输入返回 null。 */
function ipv6Hextets(address: string): number[] | null {
  const [head, tail] = address.split("::");
  const parse = (part: string | undefined): number[] => {
    if (!part) {
      return [];
    }
    const hextets: number[] = [];
    for (const chunk of part.split(":")) {
      // 末尾可能内嵌点分 IPv4（::ffff:127.0.0.1）。
      if (chunk.includes(".")) {
        const v4 = ipv4ToInt(chunk);
        if (v4 === null) {
          return [];
        }
        hextets.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      const value = Number.parseInt(chunk, 16);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        return [];
      }
      hextets.push(value);
    }
    return hextets;
  };

  const left = parse(head);
  const right = parse(tail);
  if (address.includes("::")) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) {
      return null;
    }
    return [...left, ...Array<number>(fill).fill(0), ...right];
  }
  return left.length === 8 ? left : null;
}

function isBlockedIpv6(address: string): boolean {
  const hextets = ipv6Hextets(address.toLowerCase().split("%")[0]);
  if (!hextets) {
    // 解析不了就按危险处理（fail closed）。
    return true;
  }
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  const embeddedIpv4 = (h6 << 16) | h7;
  // ::1 环回、:: 未指定。
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    if (embeddedIpv4 === 0 || embeddedIpv4 === 1) {
      return true;
    }
  }
  // IPv4-mapped (::ffff:a.b.c.d) 与已废弃的 IPv4-compatible (::a.b.c.d)：
  // 内嵌的 IPv4 才是真实目标，必须按 IPv4 规则判断。
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0) {
    if (h5 === 0xffff || h5 === 0) {
      return isBlockedIpv4(`${(embeddedIpv4 >>> 24) & 0xff}.${(embeddedIpv4 >>> 16) & 0xff}.${(embeddedIpv4 >>> 8) & 0xff}.${embeddedIpv4 & 0xff}`);
    }
  }
  // NAT64 64:ff9b::/96：同样内嵌 IPv4。
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isBlockedIpv4(`${(embeddedIpv4 >>> 24) & 0xff}.${(embeddedIpv4 >>> 16) & 0xff}.${(embeddedIpv4 >>> 8) & 0xff}.${embeddedIpv4 & 0xff}`);
  }
  // 唯一本地 fc00::/7、链路本地 fe80::/10、组播 ff00::/8、文档 2001:db8::/32、
  // 丢弃段 100::/64。
  if ((h0 & 0xfe00) === 0xfc00) return true;
  if ((h0 & 0xffc0) === 0xfe80) return true;
  if ((h0 & 0xff00) === 0xff00) return true;
  if (h0 === 0x2001 && h1 === 0x0db8) return true;
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
  return false;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isBlockedIpv4(address);
  }
  if (family === 6) {
    return isBlockedIpv6(address);
  }
  return true;
}

/**
 * 校验一个出站 base URL；通过则返回规范化后的 URL 对象。
 *
 * @param rawUrl 管理员填写/保存的上游地址
 * @throws BlockedUrlError 协议非法、主机被禁止，或解析到内部地址
 */
export async function assertOutboundUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("上游地址不是合法的 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("上游地址必须使用 http 或 https。");
  }
  // URL 会把 IPv6 主机包在方括号里。
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) {
    throw new BlockedUrlError("上游地址缺少主机名。");
  }
  if (BLOCKED_HOSTNAMES[hostname] === true) {
    throw new BlockedUrlError("上游地址指向本机或云元数据服务，已被拒绝。");
  }
  // 字面量 IP 直接判断，避免多一次 DNS 往返。
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedUrlError("上游地址指向内网或保留地址，已被拒绝。");
    }
    return url;
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError("无法解析上游地址的主机名。");
  }
  if (resolved.length === 0) {
    throw new BlockedUrlError("无法解析上游地址的主机名。");
  }
  // 任一解析结果落在内网即拒绝：多 A 记录时不能让攻击者用一条公网记录绕过。
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      throw new BlockedUrlError("上游地址解析到内网或保留地址，已被拒绝。");
    }
  }
  return url;
}
