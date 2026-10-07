// @ts-nocheck
/**
 * Edge-weighted chromatic aberration post node.
 * Adapted from ektogamat/threejs-conference (Threejs-Punk), MIT licence.
 * See THIRD_PARTY.md.
 */
import { TempNode } from 'three/webgpu';
import { nodeObject, Fn, convertToTexture, float, vec2, vec4, uv, fract, sin, dot } from 'three/tsl';

class EdgeChromaticAberrationNode extends TempNode {
  static get type() {
    return 'EdgeChromaticAberrationNode';
  }

  constructor(textureNode, strengthNode, edgeFalloffNode, centerNode) {
    super('vec4');
    this.textureNode = textureNode;
    this.strengthNode = strengthNode;
    this.edgeFalloffNode = edgeFalloffNode;
    this.centerNode = centerNode;
  }

  setup() {
    const textureNode = this.textureNode;
    const uvNode = textureNode.uvNode || uv();

    const dither = Fn(([screenPos]) => {
      const hash = fract(sin(dot(screenPos, vec2(12.9898, 78.233))).mul(float(43758.5453)));
      return hash.sub(float(0.5)).mul(float(2.0)).mul(float(0.004));
    });

    const apply = Fn(([uvCoord, strength, edgeFalloff, center]) => {
      const offset = uvCoord.sub(center);
      const distance = offset.length();
      const edgeMask = float(1.0).sub(float(1.0).div(float(1.0).add(distance.mul(edgeFalloff).pow(2.0))));
      const effective = strength.mul(edgeMask);
      const redUV = center.add(offset.mul(float(1.0).add(effective.mul(0.015))));
      const blueUV = center.add(offset.mul(float(1.0).sub(effective.mul(0.015))));
      const r = textureNode.sample(redUV).r;
      const g = textureNode.sample(uvCoord).g;
      const b = textureNode.sample(blueUV).b;
      const a = textureNode.sample(uvCoord).a;
      const d = dither(uvCoord);
      return vec4(r.add(d), g.add(d), b.add(d), a);
    });

    return Fn(() => apply(uvNode, this.strengthNode, this.edgeFalloffNode, this.centerNode))();
  }
}

export const edgeChromaticAberration = (node, strength = 1.0, edgeFalloff = 3.0, center = null) => {
  if (center === null) center = vec2(0.5, 0.5);
  return nodeObject(new EdgeChromaticAberrationNode(convertToTexture(node), nodeObject(strength), nodeObject(edgeFalloff), nodeObject(center)));
};
