// @vitest-environment jsdom
// Manual smoke test (not part of `npm test`): starts the real server, loads the sample town, and renders the real screens.
// Run:  npm run smoke -w @bharatpulse/web
import { spawn, type ChildProcess } from 'node:child_process';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

window.scrollTo = () => undefined; // jsdom does not implement it
const PORT = 3998;
let server: ChildProcess;
const base = `http://localhost:${PORT}`;

beforeAll(async () => {
  server = spawn('npx', ['tsx', '../server/src/server.ts'], { env: { ...process.env, PORT: String(PORT), OTP_CODE: '123456', GEOFENCE: 'false', PLACES: 'off', SARVAM_API_KEY: '' }, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); }
  vi.stubEnv('VITE_API_URL', base);
}, 60_000);
afterAll(() => { server?.kill(); spawn('pkill', ['-f', 'server/src/server.ts']); });

const quiet = () => { const errors: unknown[] = []; const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); }); return () => { spy.mockRestore(); return errors; }; };

describe('real screens against the real server', () => {
  it('home page offers both portals', async () => {
    location.hash = '#/';
    const { App } = await import('../src/App');
    render(<App />);
    expect(screen.getByText('Citizen')).toBeTruthy();
    expect(screen.getByText('Officer')).toBeTruthy();
    expect(screen.queryByText(/verification is in test mode/i)).toBeNull();
    fireEvent.click(screen.getByLabelText('Language')); // one language picker with 11 languages
    expect(screen.getAllByRole('option')).toHaveLength(11);
    fireEvent.click(screen.getByRole('option', { name: 'हिन्दी' }));
    expect(await screen.findByText('नागरिक')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('भाषा'));
    fireEvent.click(screen.getByRole('option', { name: 'English' }));
    expect(screen.getByText('Municipalities, utilities, toll roads, industrial parks and campuses. One platform.')).toBeTruthy(); // the SaaS site: why a city adopts it
    cleanup();
  });

  it('officer signs in, loads the sample town, and works the board', async () => {
    const { api } = await import('../src/api');
    await api.officerLogin('zonal1', 'officer@123');
    await api.seed();
    location.hash = '#/officer';
    const { App } = await import('../src/App');
    const done = quiet();
    render(<App />);
    for (const col of ['New', 'Working', 'Fix check', 'Done']) expect((await screen.findAllByText(col, {}, { timeout: 15_000 })).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/min ago|h ago|h \d+ min ago/)).length).toBeGreaterThan(3); // every card says how long ago it was reported
    expect(screen.getAllByText(/Forwarded to me/).length).toBeGreaterThan(0);

    // a card with a fix photo waiting opens a panel where the photo can be checked
    fireEvent.click((await screen.findAllByText('Leak or burst'))[0]);
    expect(await screen.findByText(/Fix photo from the field officer: please check it/, {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByText('Photo is correct: approve')).toBeTruthy();
    expect(screen.getByText('first reported')).toBeTruthy();
    expect(screen.getByLabelText('Photo of the fix: open full size')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Photo of the fix: open full size'));
    expect(screen.getByLabelText('Zoom in')).toBeTruthy(); // the full-size viewer
    fireEvent.click(screen.getAllByLabelText('Close').at(-1)!); // the viewer's close button
    fireEvent.keyDown(window, { key: 'Escape' });

    // an area on the watchlist opens that area
    fireEvent.click((await screen.findAllByText(/^Zone \d/)).find((e) => e.closest('.zonechip'))!);
    expect(await screen.findByText('Why this area is on the list')).toBeTruthy();
    expect(screen.getByText(/Open problems here/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });

    // single reports are visible, and a reload keeps the officer signed in
    fireEvent.click(screen.getAllByText('New reports')[0]);
    expect(await screen.findByText(/Single reports waiting for neighbours/)).toBeTruthy();
    const errs = done(); if (errs.length) console.log("ERRS", JSON.stringify(errs).slice(0, 600)); expect(errs).toEqual([]);
    cleanup();
    location.hash = '#/officer';
    render(<App />);
    expect((await screen.findAllByText('Fix check', {}, { timeout: 15_000 })).length).toBeGreaterThan(0);
    cleanup();
    api.officerLogout();
  }, 40_000);

  it('officer sign-in rejects a wrong password and a wrong level', async () => {
    const { api } = await import('../src/api');
    await expect(api.officerLogin('zonal1', 'nope')).rejects.toThrow(/Wrong officer/);
    // The level comes from the account now; a client cannot claim another level.
  });

  it('citizen verifies by OTP, gives a name, then sees the form, nearby problems and help, and signing out goes home', async () => {
    const { api } = await import('../src/api');
    api.logout();
    localStorage.removeItem('bp_name'); localStorage.removeItem('bp_name_skip');
    location.hash = '#/citizen';
    const { App } = await import('../src/App');
    const done = quiet();
    render(<App />);
    expect((await screen.findAllByText('Verify your phone')).length).toBeGreaterThan(0);
    expect(screen.getByText('Back to home')).toBeTruthy();
    cleanup();
    await api.otpRequest('9876543210');
    await api.verify('9876543210', '123456');
    render(<App />);
    expect(await screen.findByText('What should we call you?')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: 'Arjun' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText(/Hello Arjun/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Language')); fireEvent.click(screen.getByRole('option', { name: 'हिन्दी' })); // switch to Hindi: the name follows
    expect(await screen.findByText('अपना नाम हिंदी में लिखें')).toBeTruthy();
    expect((screen.getByDisplayValue('अर्जुन') as HTMLInputElement).value).toBe('अर्जुन');
    fireEvent.click(screen.getByText('सहेजें'));
    expect(await screen.findByText(/नमस्ते अर्जुन/)).toBeTruthy();
    expect(screen.getByText('पास की शिकायतें')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('भाषा')); fireEvent.click(screen.getByRole('option', { name: 'English' }));
    expect(await screen.findByText('Nearby Complaints')).toBeTruthy();
    expect(screen.getByText('Report Water Issue')).toBeTruthy();
    fireEvent.click(screen.getByText('Alerts'));
    expect(await screen.findByText(/No updates yet/)).toBeTruthy();
    fireEvent.click(screen.getByText('Help'));
    expect(await screen.findByText('Need help now?')).toBeTruthy();
    expect(screen.getByText('Find my location')).toBeTruthy();
    fireEvent.click(screen.getByText('Track'));
    expect(await screen.findByText('You have not reported anything yet.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Sign out'));
    await waitFor(() => expect(location.hash).toBe('#/'));
    const errs = done(); if (errs.length) console.log("ERRS", JSON.stringify(errs).slice(0, 600)); expect(errs).toEqual([]);
    cleanup();

    // the phone is remembered: one tap, no new code
    location.hash = '#/citizen';
    render(<App />);
    fireEvent.click(await screen.findByText(/Continue as \+91/));
    expect(await screen.findByText(/Hello Arjun/)).toBeTruthy();
    expect(screen.queryByText('Enter the 6-digit code')).toBeNull();
    cleanup();
  }, 40_000);

  it('a signed-in citizen is remembered after a page reload', async () => {
    const { api } = await import('../src/api');
    await api.verify('9876543210', '123456');
    localStorage.setItem('bp_name', 'Arjun');
    location.hash = '#/citizen';
    const { App } = await import('../src/App');
    render(<App />);
    expect(await screen.findByText(/Hello Arjun/)).toBeTruthy();
    cleanup();
  });

  it('the public community page shows the numbers for one area, with a way back', async () => {
    const { api } = await import('../src/api');
    api.logout();
    localStorage.setItem('bp_area', JSON.stringify({ name: 'Hodal, Palwal', lat: 27.894, lng: 77.369 })); // the sample town
    sessionStorage.setItem('bp_back', '#/officer');
    location.hash = '#/community';
    const { App } = await import('../src/App');
    render(<App />);
    expect(await screen.findByText('How is your area doing?')).toBeTruthy();
    expect(await screen.findByText('Ward 2')).toBeTruthy();
    expect(await screen.findByText('Recently fixed')).toBeTruthy();
    expect(screen.getByText('Hodal, Palwal')).toBeTruthy();
    expect(screen.getByText('10 km')).toBeTruthy();
    fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(location.hash).toBe('#/officer'));
    localStorage.removeItem('bp_area');
    cleanup();
    location.hash = '#/community';
    render(<App />);
    expect(await screen.findByText(/Allow location, or search for a town/)).toBeTruthy(); // no location and no chosen area: nothing listed
    cleanup();
  }, 30_000);

  it('a shared link shows the problem and lets a neighbour confirm it', async () => {
    const { api } = await import('../src/api');
    await api.officerLogin('zonal1', 'officer@123');
    const report = (await api.pending())[0];
    api.officerLogout();
    await api.verify('9876543299', '123456');
    location.hash = `#/join/${encodeURIComponent(report.id)}`;
    const { App } = await import('../src/App');
    render(<App />);
    expect(await screen.findByText('A neighbour reported this problem')).toBeTruthy();
    expect(screen.getByText('I have this too')).toBeTruthy();
    cleanup();
    location.hash = '#/join/does-not-exist';
    render(<App />);
    expect(await screen.findByText('This report is no longer open.')).toBeTruthy();
    cleanup();
  }, 30_000);

  it('new everyday features: planned-work notice, water diary, map and recently fixed near you, announcements, supply on the public page', async () => {
    const { api } = await import('../src/api');
    const geo = { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 27.894, longitude: 77.369, accuracy: 30 } }), watchPosition: (ok: (p: unknown) => void) => { ok({ coords: { latitude: 27.894, longitude: 77.369, accuracy: 30 } }); return 1; }, clearWatch: () => undefined };
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    await api.verify('9876543210', '123456');
    localStorage.setItem('bp_name', 'Arjun');
    location.hash = '#/citizen';
    const { App } = await import('../src/App');
    const done = quiet();
    render(<App />);
    expect(await screen.findByText(/Planned water cut: valve repair/, {}, { timeout: 15_000 })).toBeTruthy(); // announced by officers, shown before anyone complains
    expect(screen.getByText('Did water come today?')).toBeTruthy();
    fireEvent.click(screen.getByText('Yes, on time'));
    expect(await screen.findByText(/Many answers together show how supply really is/)).toBeTruthy();
    expect((await screen.findAllByText(/Fixed today near here/)).length).toBeGreaterThan(0); // fixed close by: "is it back?"
    fireEvent.click(screen.getByText('Map'));
    expect(document.querySelector('.leaflet-container')).toBeTruthy();
    const errs = done(); if (errs.length) console.log("ERRS", JSON.stringify(errs).slice(0, 600)); expect(errs).toEqual([]);
    cleanup();
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });

    await api.officerLogin('zonal1', 'officer@123');
    location.hash = '#/officer';
    render(<App />);
    fireEvent.click((await screen.findAllByText('Notices'))[0]);
    expect(await screen.findByText('Announce planned work')).toBeTruthy();
    expect((await screen.findAllByText(/Planned water cut: valve repair/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Road resurfacing near the Ward 6 market')).toBeTruthy();
    cleanup();
    api.officerLogout();

    localStorage.setItem('bp_area', JSON.stringify({ name: 'Hodal', lat: 27.894, lng: 77.369 }));
    location.hash = '#/community';
    render(<App />);
    expect(await screen.findByText('Water supply this week')).toBeTruthy();
    expect((await screen.findAllByText('Needs attention')).length).toBeGreaterThan(0); // the ward where residents' diary shows water keeps failing
    localStorage.removeItem('bp_area');
    cleanup();
  }, 40_000);
});
