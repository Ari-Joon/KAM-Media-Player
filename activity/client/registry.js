/**
 * The visualisation registry.
 *
 * Lives in its own module so that both the Activity (`main.js`) and the
 * development harness (`preview.js`) build their menus from one list. Keeping it
 * in `main.js` would have meant the harness either importing that file - which
 * constructs a `DiscordSDK` at module scope and immediately runs `main()`, so it
 * cannot be imported outside Discord - or duplicating the list and drifting from
 * it the first time a visualisation was added.
 */

import { StickMenVisual } from './stickmen.js';
import { PainterVisual } from './painter.js';
import {
  BarsVisual, ScopeVisual, TunnelVisual, ColoursVisual,
  ParticlesVisual, KaleidoscopeVisual, VinylVisual, NoneVisual,
} from './visuals.js';
import {
  GalaxyVisual, TerrainVisual, RainVisual, FirefliesVisual, RibbonsVisual, MosaicVisual, AuroraVisual,
  PulseVisual,
} from './visuals2.js';
import { NowPlayingVisual } from './nowplaying.js';

/**
 * Available visualisations, in menu order.
 *
 * All of them draw into one shared 2D canvas, which every Discord client
 * provides. The WebGL entry that used to sit alongside them has gone.
 */
export const VISUALS = [
  { id: 'none', name: 'None (no visuals)', make: (c) => new NoneVisual(c) },
  { id: 'stickmen', name: 'Stick Men', make: (c) => new StickMenVisual(c) },
  { id: 'painter', name: 'Painter', make: (c) => new PainterVisual(c) },
  // High in the list on purpose: about the track itself rather than the
  // analysis, and what people reach for when they want to know what is playing
  // rather than to watch something.
  //
  // "Lyrics" used to sit beside it. Nothing produces lyrics any more - see the
  // note in `nowplaying.js` - so the entry could only ever have shown "No
  // lyrics for this track", which is worse than not offering it.
  { id: 'nowplaying', name: 'Now Playing', make: (c) => new NowPlayingVisual(c) },
  { id: 'bars', name: 'Bars & Waves', make: (c) => new BarsVisual(c) },
  { id: 'scope', name: 'Scope', make: (c) => new ScopeVisual(c) },
  { id: 'tunnel', name: 'Tunnel', make: (c) => new TunnelVisual(c) },
  { id: 'colours', name: 'Musical Colours', make: (c) => new ColoursVisual(c) },
  { id: 'alchemy', name: 'Alchemy', make: (c) => new ParticlesVisual(c) },
  { id: 'kaleidoscope', name: 'Kaleidoscope', make: (c) => new KaleidoscopeVisual(c) },
  { id: 'vinyl', name: 'Vinyl', make: (c) => new VinylVisual(c) },
  { id: 'galaxy', name: 'Galaxy', make: (c) => new GalaxyVisual(c) },
  { id: 'terrain', name: 'Terrain', make: (c) => new TerrainVisual(c) },
  { id: 'rain', name: 'Rain', make: (c) => new RainVisual(c) },
  { id: 'fireflies', name: 'Fireflies', make: (c) => new FirefliesVisual(c) },
  { id: 'ribbons', name: 'Ribbons', make: (c) => new RibbonsVisual(c) },
  { id: 'mosaic', name: 'Mosaic', make: (c) => new MosaicVisual(c) },
  { id: 'aurora', name: 'Aurora', make: (c) => new AuroraVisual(c) },
  { id: 'pulse', name: 'Pulse', make: (c) => new PulseVisual(c) },
];
