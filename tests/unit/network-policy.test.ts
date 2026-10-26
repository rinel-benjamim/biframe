import { describe, expect, it } from 'vitest';
import {
  classifyNavigation,
  classifyResource,
  hostFromUrl,
  isPrivateAddressList,
  isPrivateHost,
  isPrivateIpv4,
  isPrivateIpv6,
  isRemoteHostName,
  projectUrlFor,
} from '@engine/network/policy';

const options = { projectOrigin: 'http://127.0.0.1:43210', allowRemote: true };

describe('private host detection', () => {
  it('marks loopback, private, link-local and special names as private', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'printer.local',
      'metadata.google.internal',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.20',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('allows ordinary public hosts', () => {
    for (const host of ['example.com', 'fonts.googleapis.com', '8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
      expect(isPrivateHost(host), host).toBe(false);
      expect(isRemoteHostName(host), host).toBe(true);
    }
  });

  it('parses only valid IPv4 literals', () => {
    expect(isPrivateIpv4('10.0.0.1')).toBe(true);
    expect(isPrivateIpv4('999.0.0.1')).toBe(false);
    expect(isPrivateIpv4('example.com')).toBe(false);
  });

  it('understands IPv6 loopback, unique-local, link-local and mapped IPv4', () => {
    expect(isPrivateIpv6('::1')).toBe(true);
    expect(isPrivateIpv6('[::1]')).toBe(true);
    expect(isPrivateIpv6('fc00::1')).toBe(true);
    expect(isPrivateIpv6('fe80::1')).toBe(true);
    expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIpv6('example.com')).toBe(false);
  });

  it('fails closed on tunnelled, mapped and special IPv6 forms', () => {
    expect(isPrivateIpv6('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIpv6('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateIpv6('::127.0.0.1')).toBe(true);
    expect(isPrivateIpv6('2002:7f00:1::')).toBe(true);
    expect(isPrivateIpv6('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateIpv6('ff02::1')).toBe(true);
    expect(isPrivateIpv6('2001:db8::1')).toBe(true);
    expect(isPrivateIpv6('100::1')).toBe(true);
    expect(isPrivateIpv6('fe80::1%eth0')).toBe(true);
    expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIpv6('not:an:ip')).toBe(false);
  });

  it('fails closed when DNS returns no address', () => {
    expect(isPrivateAddressList([])).toBe(true);
    expect(isPrivateAddressList(['8.8.8.8'])).toBe(false);
    expect(isPrivateAddressList(['8.8.8.8', '127.0.0.1'])).toBe(true);
  });

  it('extracts a hostname or returns null for garbage', () => {
    expect(hostFromUrl('https://Example.COM/path')).toBe('example.com');
    expect(hostFromUrl('not a url')).toBeNull();
  });
});

describe('resource policy', () => {
  it('allows the project origin and inline data', () => {
    expect(classifyResource('http://127.0.0.1:43210/token/index.html', options)).toEqual({
      action: 'allow',
      kind: 'project',
    });
    expect(classifyResource('data:image/png;base64,AAAA', options)).toEqual({ action: 'allow', kind: 'data' });
    expect(classifyResource('blob:http://127.0.0.1:43210/abc', options)).toEqual({ action: 'allow', kind: 'data' });
    expect(classifyResource('about:blank', options)).toEqual({ action: 'allow', kind: 'project' });
  });

  it('allows remote resources only when the user opted in', () => {
    expect(classifyResource('https://fonts.googleapis.com/css2?family=Inter', options)).toEqual({
      action: 'allow',
      kind: 'remote',
    });
    expect(classifyResource('https://fonts.googleapis.com/css2', { ...options, allowRemote: false })).toMatchObject({
      action: 'block',
      reason: 'remote-disabled',
    });
  });

  it('blocks a different loopback port as a private network target', () => {
    expect(classifyResource('http://127.0.0.1:43211/token/index.html', options)).toMatchObject({
      action: 'block',
      reason: 'private-network',
    });
  });

  it('blocks private addresses even when remote resources are enabled', () => {
    expect(classifyResource('http://localhost:8080/admin', options)).toMatchObject({
      action: 'block',
      reason: 'private-network',
    });
    expect(classifyResource('http://169.254.169.254/latest/meta-data', options)).toMatchObject({
      action: 'block',
      reason: 'private-network',
    });
  });

  it('blocks file:, ftp: and malformed urls', () => {
    expect(classifyResource('file:///C:/Windows/win.ini', options)).toMatchObject({
      action: 'block',
      reason: 'scheme-not-allowed',
    });
    expect(classifyResource('ftp://example.com/file', options)).toMatchObject({
      action: 'block',
      reason: 'scheme-not-allowed',
    });
    expect(classifyResource('http://', options)).toMatchObject({ action: 'block' });
  });

  it('restricts navigation to the project origin', () => {
    expect(classifyNavigation('http://127.0.0.1:43210/token/page.html', options)).toEqual({
      action: 'allow',
      kind: 'project',
    });
    expect(classifyNavigation('https://example.com', options)).toMatchObject({
      action: 'block',
      reason: 'outside-project',
    });
    expect(classifyNavigation('about:blank', options)).toEqual({ action: 'allow', kind: 'project' });
  });
});

describe('projectUrlFor', () => {
  it('joins an origin and a relative path without duplicate slashes', () => {
    expect(projectUrlFor('http://127.0.0.1:43210/', '/token/index.html')).toBe(
      'http://127.0.0.1:43210/token/index.html',
    );
    expect(projectUrlFor('http://127.0.0.1:43210', 'token/image.png')).toBe(
      'http://127.0.0.1:43210/token/image.png',
    );
  });
});
