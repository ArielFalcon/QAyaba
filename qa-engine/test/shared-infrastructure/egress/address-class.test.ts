import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAddress } from "../../../src/shared-infrastructure/egress/address-class.ts";

test("public addresses are public", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "169.253.1.1", "2606:4700:4700::1111"]) {
    assert.equal(classifyAddress(address), "public", address);
  }
});

test("the ranges a sandboxed child must not reach through a name are each told apart", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"], ["::1", "loopback"], ["::ffff:127.0.0.1", "loopback"], ["0.0.0.0", "loopback"], ["0.1.2.3", "loopback"], ["::", "loopback"],
    ["10.0.0.1", "private"], ["10.255.255.255", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.0.1", "private"], ["::ffff:10.1.2.3", "private"],
    ["169.254.169.254", "link-local"], ["169.254.0.1", "link-local"], ["fe80::1", "link-local"], ["febf::1", "link-local"],
    ["100.64.0.1", "cgnat"], ["100.127.255.255", "cgnat"],
    ["224.0.0.1", "multicast"], ["239.255.255.255", "multicast"], ["ff02::1", "multicast"],
    ["fc00::1", "unique-local"], ["fdff::1", "unique-local"],
    ["192.0.0.1", "reserved"], ["198.18.0.1", "reserved"], ["198.19.255.255", "reserved"], ["240.0.0.1", "reserved"], ["255.255.255.255", "reserved"],
  ];
  for (const [address, expected] of cases) assert.equal(classifyAddress(address), expected, address);
});

test("something that is not an address is not public", () => {
  for (const bad of ["", "not-an-ip", "1.2.3", "999.1.1.1", "1.2.3.4.5"]) assert.notEqual(classifyAddress(bad), "public", bad);
});
