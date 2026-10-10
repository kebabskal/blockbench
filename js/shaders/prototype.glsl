// Prototype grid pattern for elements without a texture, like the checker textures used for blockouts in game engines.
// Tiles are PROTOTYPE_SIZE units wide in world space, projected along the axis the surface faces most.
uniform bool PROTOTYPE;
uniform vec3 PROTOTYPE_COLOR;
uniform float PROTOTYPE_SIZE;
// -1 dark, 0 medium, 1 light shade of PROTOTYPE_COLOR
uniform float PROTOTYPE_TONE;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

// Antialiased lines at whole numbers of the coordinate, about one pixel wide
float prototypeLines(vec2 coord) {
	vec2 width = max(fwidth(coord), vec2(1e-5));
	vec2 dist = abs(fract(coord - 0.5) - 0.5) / width;
	float line = 1.0 - clamp(min(dist.x, dist.y) - 0.5, 0.0, 1.0);
	// Fade out lines that would be too dense to tell apart
	return line * clamp(1.5 - max(width.x, width.y) * 5.0, 0.0, 1.0);
}

vec3 prototypeColor() {
	vec3 n = abs(vWorldNormal);
	vec2 p;
	if (n.x >= n.y && n.x >= n.z) {
		p = vWorldPos.zy;
	} else if (n.y >= n.z) {
		p = vWorldPos.xz;
	} else {
		p = vWorldPos.xy;
	}
	vec2 cell = p / max(PROTOTYPE_SIZE, 0.001);
	float checker = mod(floor(cell.x) + floor(cell.y), 2.0);
	vec3 base_color = PROTOTYPE_TONE > 0.0
		? mix(PROTOTYPE_COLOR, vec3(1.0), 0.35 * PROTOTYPE_TONE)
		: PROTOTYPE_COLOR * (1.0 + 0.3 * PROTOTYPE_TONE);
	vec3 color = base_color * mix(1.0, 0.88, checker);
	// Faint lines every quarter tile, stronger lines at the tile edges
	color *= 1.0 - 0.07 * prototypeLines(cell * 4.0);
	color *= 1.0 - 0.22 * prototypeLines(cell);
	return color;
}
