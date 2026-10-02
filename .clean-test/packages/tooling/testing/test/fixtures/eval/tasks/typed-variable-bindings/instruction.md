Typed variable declarations are dynamically typed today, with no mechanism to enforce type constraints after declaration.

Add `var x: type = value` syntax for typed variable declarations. When the TypedBindings option is enabled, the VM enforces type constraints on assignment.

When TypedBindings is disabled, typed declaration syntax still parses and executes, but constraint enforcement is not applied and assignments behave dynamically.

Syntax forms:
- `var x: int64 = 10`
- `var x: int64`
- `var a, b: int64 = 1, 2`

Assignments to typed variables must match the declared type in any scope. No implicit type conversion is performed.

For type-mismatch errors the message must contain the literal `type error`, the variable name, the source type, and the declared target type.

Declaring an unknown type must return an error containing `unknown type` or `undefined type`.

Typed declarations without initial values are initialized to the zero value for that type.

Blank identifier `_` is exempt from constraint checking.

IMPORTANT: please work on this in a new branch and commit everything when you are done.
