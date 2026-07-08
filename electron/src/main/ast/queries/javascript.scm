; JavaScript symbol captures for tree-sitter
; Capture naming: name.definition.<kind>, definition.<kind>, name.reference

(function_declaration
  name: (identifier) @name.definition.function
  body: (statement_block) @definition.function)

(class_declaration
  name: (identifier) @name.definition.class
  body: (class_body) @definition.class)

(arrow_function) @definition.function

(variable_declarator
  name: (identifier) @name.definition.function
  value: (arrow_function) @definition.function)

(method_definition
  name: (property_identifier) @name.definition.method
  body: (statement_block) @definition.method)

(identifier) @name.reference
