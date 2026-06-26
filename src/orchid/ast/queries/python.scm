; Python symbol captures for tree-sitter
; Capture naming: name.definition.<kind>, definition.<kind>, name.reference

(function_definition
  name: (identifier) @name.definition.function
  body: (block) @definition.function)

(class_definition
  name: (identifier) @name.definition.class
  body: (block) @definition.class)

(identifier) @name.reference
