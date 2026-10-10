// Prototype grid pattern for elements without a texture, like the checker textures used for blockouts in game engines.
// Tiles are PROTOTYPE_SIZE units wide in world space, projected along the axis the surface faces most.
uniform bool PROTOTYPE;
uniform vec3 PROTOTYPE_COLOR;
uniform float PROTOTYPE_SIZE;
// -1 dark, 0 medium, 1 light shade of PROTOTYPE_COLOR
uniform float PROTOTYPE_TONE;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

vec3 rgbToHsl(vec3 c) {
	float max_c = max(c.r, max(c.g, c.b));
	float min_c = min(c.r, min(c.g, c.b));
	float l = (max_c + min_c) * 0.5;
	float d = max_c - min_c;
	if (d < 1e-5) return vec3(0.0, 0.0, l);
	float s = l > 0.5 ? d / (2.0 - max_c - min_c) : d / (max_c + min_c);
	float h;
	if (max_c == c.r) {
		h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
	} else if (max_c == c.g) {
		h = (c.b - c.r) / d + 2.0;
	} else {
		h = (c.r - c.g) / d + 4.0;
	}
	return vec3(h / 6.0, s, l);
}
vec3 hslToRgb(vec3 hsl) {
	vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
	return hsl.z + hsl.y * (rgb - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}
// Same hue and saturation as the grid color, only lighter or darker
vec3 prototypeShade(vec3 color, float tone) {
	vec3 hsl = rgbToHsl(color);
	hsl.z = tone > 0.0 ? mix(hsl.z, 1.0, 0.35 * tone) : hsl.z * (1.0 + 0.3 * tone);
	return hslToRgb(hsl);
}

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
	vec3 base_color = PROTOTYPE_TONE == 0.0 ? PROTOTYPE_COLOR : prototypeShade(PROTOTYPE_COLOR, PROTOTYPE_TONE);
	vec3 color = base_color * mix(1.0, 0.88, checker);
	// Faint lines every quarter tile, stronger lines at the tile edges
	color *= 1.0 - 0.07 * prototypeLines(cell * 4.0);
	color *= 1.0 - 0.22 * prototypeLines(cell);
	return color;
}
