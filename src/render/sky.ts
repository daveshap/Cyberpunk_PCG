// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Sky dome: night gradient, city glow, a cloud deck lit from below, stars, and
 * three layers of distant skyline silhouettes beyond the city so the horizon
 * reads as more sprawl rather than an edge.
 */
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, normalize, positionWorld, vec4 } from 'three/tsl';
import { skyColor, skyline } from './tsl';

export function createSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(5000, 48, 24);
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  mat.fog = false;
  mat.colorNode = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));
    const base = skyColor(dir);
    return vec4(skyline(dir, base, cameraPosition.y), 1.0);
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}
