export const str = (maxLength = 200) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
export const uuid = { type: "string", format: "uuid" };
export const obj = (
  properties: Record<string, any>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
export const email = { type: "string", format: "email", maxLength: 254 };
export const password = { type: "string", minLength: 15, maxLength: 128 };
export const idParams = obj({ id: uuid });
export const page = { type: "integer", minimum: 1, maximum: 100, default: 25 };
