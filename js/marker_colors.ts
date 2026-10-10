export type MarkerColor = {
	id: string
	name?: string
	pastel: string
	standard: string
	/** Show elements with this color with the prototype grid, see shaders/prototype.glsl */
	prototype?: boolean
}
export const markerColors: MarkerColor[] = [
	{pastel: "#A2EBFF", standard: "#58C0FF", id: 'light_blue'},
	{pastel: "#FFF899", standard: "#F4D714", id: 'yellow'},
	{pastel: "#F1BB75", standard: "#EC9218", id: 'orange'},
	{pastel: "#FF9B97", standard: "#FA565D", id: 'red'},
	{pastel: "#C5A6E8", standard: "#B55AF8", id: 'purple'},
	{pastel: "#A6C8FF", standard: "#4D89FF", id: 'blue'},
	{pastel: "#7BFFA3", standard: "#00CE71", id: 'green'},
	{pastel: "#BDFFA6", standard: "#AFFF62", id: 'lime'},
	{pastel: "#FFA5D5", standard: "#F96BC5", id: 'pink'},
	{pastel: "#E0E9FB", standard: "#C7D5F6", id: 'silver'},
	// Appended so the indices of the other colors in saved files stay the same
	{pastel: "#B4B9C2", standard: "#9AA0A8", id: 'prototype', prototype: true},
]
/**
 * Random marker color index, leaving out the prototype color so random colors stay colorful
 */
export function getRandomMarkerColor(): number {
	let options = markerColors.map((color, i) => i).filter(i => !markerColors[i].prototype);
	return options[Math.floor(Math.random() * options.length)];
}
/**
 * Marker color index for newly created elements
 */
export function getDefaultMarkerColor(): number {
	if (settings.new_element_marker_color?.value == 'random') return getRandomMarkerColor();
	let prototype = markerColors.findIndex(color => color.prototype);
	return prototype == -1 ? getRandomMarkerColor() : prototype;
}
const global = {markerColors, getRandomMarkerColor, getDefaultMarkerColor};
declare global {
	const markerColors: typeof global.markerColors
	const getRandomMarkerColor: typeof global.getRandomMarkerColor
	const getDefaultMarkerColor: typeof global.getDefaultMarkerColor
}
Object.assign(window, global);
