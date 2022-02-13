#include "baseclasses.hpp"
namespace baseclasses
{
    void main() {
        Bar* a = new Bar{10};
        Bar* someLongBar = new Bar{20};
        Bar cSomeLongBarValue{10};
        Bar d{20};
        Zoo z{10};
        Zoo* someLongerZooName = new Zoo{10};
        Zoo* y = new Zoo{20};
        Tricky t{1337};
        Tricky* tp = new Tricky{42};
        Tricky* nptr = nullptr;
}
} // namespace baseclasses
