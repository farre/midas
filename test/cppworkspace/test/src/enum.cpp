#include "enum.hpp"

FooEnum enum_stuff() {
    FooEnum f = FooEnum::Bar;
    auto e = f;
    return e;
}