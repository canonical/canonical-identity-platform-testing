// Claims → traits for the google provider, against docker/kratos/identity.schema.json
// (flat string traits — `name` is a string, given/family names are their own
// traits). Same shape as kratos.dex.jsonnet: the schema is provider-agnostic.
// Never use `||` on claims here: it is a boolean operator in jsonnet, and a
// string operand makes every Google callback 500 with "Unexpected type
// string, expected boolean".
local claims = std.extVar('claims');

{
  identity: {
    traits: {
      [if 'email' in claims then 'email' else null]: claims.email,
      [if 'name' in claims then 'name' else null]: claims.name,
      [if 'given_name' in claims then 'given_name' else null]: claims.given_name,
      [if 'family_name' in claims then 'family_name' else null]: claims.family_name,
      [if 'picture' in claims then 'picture' else null]: claims.picture,
      [if 'locale' in claims then 'locale' else null]: claims.locale,
    },
  },
}
