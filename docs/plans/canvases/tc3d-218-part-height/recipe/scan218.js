async (page) => {
  // Top-down 5,000 m over the selected airport, tileset SSE 2, then the lane census over every selected tile.
  return await page.evaluate(async () => {
    const m = window.__m;
    const vs = window.__tc3d.stores.viewport.getState();
    vs.setViewMode('topdown');
    await new Promise((r) => setTimeout(r, 800));
    vs.setPositionOffsetX(0);
    vs.setPositionOffsetY(0);
    vs.setPositionOffsetZ(0);
    vs.setTopdownAltitude(5000);
    m.tileset().maximumScreenSpaceError = 2;
    await new Promise((r) => setTimeout(r, 2000));
    await m.settle(120000);
    const icao = new URL(location.href).searchParams.get('airport');
    const arp = icao === 'KOAK' ? { lat: 37.7213, lon: -122.2208 } : { lat: 37.6189, lon: -122.375 };
    const all = m.scan();
    const near = m.scan({ ...arp, r: 3500 });
    const short = (r) =>
      [r.elementId, r['part#elementId'], r.name ?? '', 'pL=' + (r['part#building:levels'] ?? '-'), 'pH=' + (r['part#height'] ?? '-'),
       'L=' + (r['building:levels'] ?? '-'), 'H=' + (r.height ?? '-'), 'drawn A/B/C=' + r.A.drawn + '/' + r.B.drawn + '/' + r.C.drawn].join(' ');
    return {
      icao,
      all: all.census,
      near: near.census,
      nearDrawn: near.diffs.filter((r) => r.A.drawn !== r.B.drawn || r.A.drawn !== r.C.drawn).map(short),
      allDrawnAB: all.diffs.filter((r) => r.A.drawn !== r.B.drawn).slice(0, 12).map(short),
    };
  });
}
